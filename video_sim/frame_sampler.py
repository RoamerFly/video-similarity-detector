"""
Frame sampling module for video similarity search.

Provides adaptive and uniform frame sampling using decord for efficient
video frame extraction, and dynamic frame sampling based on perceptual hashing.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path
import time
from typing import Callable, Iterable, List, Optional, Tuple, Union

os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")

import cv2
import imagehash
import numpy as np
from PIL import Image
from decord import VideoReader, cpu

from video_sim.preprocess import (
    PreprocessConfig,
    prepare_frame_geometry,
    resize_prepared_frame,
)
from video_sim.metrics import RecognitionMetrics

try:
    cv2.setLogLevel(0)
except Exception:
    pass


DEFAULT_DECODE_BATCH_BYTES = 64 * 1024 * 1024
DECODE_BATCH_BYTES_ENV = "VIDEO_SIM_DECODE_BATCH_BYTES"

SAMPLER_STAGE_NAMES = (
    "sampler_decode",
    "sampler_color_convert",
    "sampler_geometry",
    "sampler_hash_resize",
    "sampler_phash",
    "sampler_clip_prepare",
    "sampler_callback",
)

# Decoder selection is part of the sampler's observable state.  In
# particular, callers can distinguish the normal sequential OpenCV path
# from the exceptional Decord fallback without inferring it from timings.
DECODER_BACKEND_UNKNOWN = "unknown"
DECODER_BACKEND_OPENCV = "opencv"
DECODER_BACKEND_DECORD = "decord"


def parse_decode_batch_bytes(value: Optional[str] = None) -> int:
    """Return the positive Decord batch budget in bytes.

    The budget is deliberately a decoded RGB-frame batch hint, rather than a
    promise about process RSS: Decord/FFmpeg may hold additional internal
    buffers. Invalid or missing environment values use the conservative
    64-MiB default.
    """
    raw_value = os.environ.get(DECODE_BATCH_BYTES_ENV) if value is None else value
    try:
        parsed = int(str(raw_value).strip())
    except (TypeError, ValueError):
        return DEFAULT_DECODE_BATCH_BYTES
    return parsed if parsed > 0 else DEFAULT_DECODE_BATCH_BYTES


def _decoded_frame_bytes(frame_shape: Optional[Tuple[int, ...]]) -> int:
    """Estimate one decoded uint8 RGB frame from its shape."""
    if frame_shape is None:
        return 0
    try:
        shape = tuple(int(dimension) for dimension in frame_shape)
    except (TypeError, ValueError):
        return 0
    if len(shape) < 2 or any(dimension <= 0 for dimension in shape):
        return 0
    # A grayscale shape is converted to BGR by _rgb_to_bgr, so account for
    # three channels when the decoder does not expose a channel dimension.
    if len(shape) == 2:
        return shape[0] * shape[1] * 3
    return int(np.prod(shape, dtype=np.int64))


def decode_batch_size_for_frame_shape(
    frame_shape: Optional[Tuple[int, ...]],
    budget_bytes: Optional[int] = None,
) -> int:
    """Choose a decoded-frame batch size that fits the requested byte hint.

    Unknown or malformed shapes use one frame, because choosing a larger
    batch without a size estimate could exceed the caller's intended bound.
    A single frame larger than the budget still uses one frame; this only
    bounds the batch request and cannot bound decoder-owned buffers or RSS.
    """
    budget = parse_decode_batch_bytes() if budget_bytes is None else max(1, int(budget_bytes))
    frame_bytes = _decoded_frame_bytes(frame_shape)
    if frame_bytes <= 0:
        return 1
    return max(1, budget // frame_bytes)


@dataclass
class RetainedFrame:
    """Information about a retained frame from dynamic sampling.

    ``clip_frame`` is an RGB ``uint8`` array already passed through
    ``preprocess_frame_for_clip``.  Embedding callers must not apply the
    geometric preprocessing a second time.
    """
    video_path: str
    frame_index: int
    timestamp: float
    phash: str
    thumbnail_path: str = ""
    clip_frame: Optional[np.ndarray] = field(default=None, repr=False, compare=False)


def compute_frame_features(frames: np.ndarray) -> np.ndarray:
    """
    Compute simple features for frames to measure visual diversity.

    Uses downsampled grayscale images as features.

    Args:
        frames: numpy array of shape (N, H, W, 3)

    Returns:
        Feature array of shape (N, feature_dim)
    """
    N, H, W, C = frames.shape

    # Simple downsampling by slicing (approx 32x32)
    h_step = max(1, H // 32)
    w_step = max(1, W // 32)

    small_frames = frames[:, ::h_step, ::w_step, :]  # (N, h, w, 3)

    # Convert to grayscale (mean over channels) and flatten
    features = small_frames.mean(axis=-1).reshape(N, -1)  # (N, h*w)

    # Normalize features
    norms = np.linalg.norm(features, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    features = features / norms

    return features


def sample_frames(
    video_path: Union[str, Path],
    num_frames: int = 16,
    adaptive: bool = True,
    oversample_factor: int = 4,
) -> np.ndarray:
    """
    Sample frames from a video file.

    Args:
        video_path: Path to the video file
        num_frames: Number of frames to sample
        adaptive: Whether to use adaptive (FPS) sampling
        oversample_factor: Factor for oversampling in adaptive mode

    Returns:
        Numpy array of shape (num_frames, H, W, 3) with dtype uint8
    """
    video_path = str(video_path)
    vr = VideoReader(video_path, ctx=cpu(0))
    total = len(vr)

    if total == 0:
        return np.zeros((0, 224, 224, 3), dtype="uint8")

    if not adaptive or total <= num_frames:
        # Uniform sampling (fallback or requested)
        idxs = np.linspace(0, total - 1, num_frames).astype(int)
        frames = vr.get_batch(idxs).asnumpy()
    else:
        # Adaptive sampling using Farthest Point Sampling (FPS)
        # 1. Sample a larger pool of candidate frames uniformly
        pool_size = min(total, num_frames * oversample_factor)
        candidate_idxs = np.linspace(0, total - 1, pool_size).astype(int)
        candidate_frames = vr.get_batch(candidate_idxs).asnumpy()

        # 2. Compute features
        features = compute_frame_features(candidate_frames)

        # 3. Farthest Point Sampling
        selected_indices_in_pool = [0]

        # Current distances to the set of selected points
        current_sims = np.dot(features, features[0])
        min_sims = current_sims

        for _ in range(num_frames - 1):
            # Find the point that has the LOWEST 'max similarity to any selected point'
            next_idx = np.argmin(min_sims)
            selected_indices_in_pool.append(next_idx)

            # Update min_sims
            new_sims = np.dot(features, features[next_idx])
            min_sims = np.maximum(min_sims, new_sims)

        # 4. Retrieve original indices and sort
        selected_indices_in_pool = sorted(selected_indices_in_pool)
        final_idxs = candidate_idxs[selected_indices_in_pool]

        # We already have the frames in memory, just pick them
        frames = candidate_frames[selected_indices_in_pool]

    # Ensure uint8 dtype
    if frames.dtype != np.uint8:
        frames = frames.astype("uint8")
    return frames


class FrameSampler:
    """Frame sampler class for video frame extraction."""

    def __init__(
        self,
        num_frames: int = 16,
        adaptive: bool = True,
        oversample_factor: int = 4,
    ):
        """
        Initialize the frame sampler.

        Args:
            num_frames: Number of frames to sample
            adaptive: Whether to use adaptive (FPS) sampling
            oversample_factor: Factor for oversampling in adaptive mode
        """
        self.num_frames = num_frames
        self.adaptive = adaptive
        self.oversample_factor = oversample_factor

    def sample(self, video_path: Union[str, Path]) -> np.ndarray:
        """
        Sample frames from a video file.

        Args:
            video_path: Path to the video file

        Returns:
            Numpy array of frames with shape (num_frames, H, W, 3)
        """
        return sample_frames(
            video_path,
            num_frames=self.num_frames,
            adaptive=self.adaptive,
            oversample_factor=self.oversample_factor,
        )

    def compute_diversity(self, frames: np.ndarray) -> float:
        """
        Compute diversity score for a set of frames.

        Lower average pairwise similarity indicates higher diversity.

        Args:
            frames: Numpy array of frames

        Returns:
            Average pairwise similarity score
        """
        features = compute_frame_features(frames)
        sim_matrix = np.dot(features, features.T)
        n = len(frames)
        if n <= 1:
            return 0.0
        avg_sim = (np.sum(sim_matrix) - n) / (n * (n - 1))
        return float(avg_sim)


def compute_phash_similarity(hash1: imagehash.ImageHash, hash2: imagehash.ImageHash) -> float:
    """
    Compute similarity between two perceptual hashes.

    Args:
        hash1: First perceptual hash
        hash2: Second perceptual hash

    Returns:
        Similarity score between 0.0 and 1.0 (1.0 = identical)
    """
    hamming_distance = hash1 - hash2
    hash_bits = hash1.hash.size  # Total number of bits in the hash
    similarity = 1.0 - hamming_distance / hash_bits
    return similarity


class DynamicFrameSampler:
    """
    Dynamic frame sampler based on perceptual hashing.

    Retains frames that are visually different from the last retained frame,
    using pHash (perceptual hash) to detect visual similarity.
    """

    def __init__(
        self,
        skip_threshold: float = 0.90,
        max_gap_sec: float = 5.0,
        frame_step: int = 1,
        cache_dir: Union[str, Path] = "data",
        preprocess_config: Optional[PreprocessConfig] = None,
        metrics: Optional[RecognitionMetrics] = None,
    ):
        """
        Initialize the dynamic frame sampler.

        Args:
            skip_threshold: Frames with similarity >= this value are skipped
            max_gap_sec: Maximum seconds between retained frames (force retain)
            frame_step: Analyze every Nth frame. 1 means every frame.
            cache_dir: Base directory for caching frames/thumbnails
            preprocess_config: Configuration for frame preprocessing (optional)
        """
        self.skip_threshold = skip_threshold
        self.max_gap_sec = max_gap_sec
        self.frame_step = max(1, int(frame_step))
        self.cache_dir = Path(cache_dir)
        self.preprocess_config = preprocess_config or PreprocessConfig()
        self.source_duration_sec = 0.0
        self.metrics = metrics
        self._preprocess_elapsed_seconds = 0.0
        self._preprocess_calls = 0
        self._sampler_stage_elapsed = {}
        self._sampler_stage_items = {}
        self._sampler_sampled_frames = 0
        self._sampler_retained_frames = 0
        self.retained_count = 0
        self.total_frames = 0
        self._retained_callback_failed = False
        # Decoder batch telemetry is intentionally limited to the decoded
        # frame request. It is not a process RSS guarantee.
        self.last_decode_batch_size: Optional[int] = None
        self.last_decode_frame_bytes: Optional[int] = None
        self.last_decode_batch_oversized = False
        self.decoder_backend = DECODER_BACKEND_UNKNOWN
        # ``last_decoder_backend`` is kept as an explicit telemetry alias for
        # integrations that report the most recently completed sample.
        self.last_decoder_backend = DECODER_BACKEND_UNKNOWN
        self.decoder_fallback = False
        self.decoder_fallback_reason: Optional[str] = None
        self.decoder_backend_history: List[str] = []

    def _mark_decoder_backend(
        self,
        backend: str,
        *,
        fallback: bool = False,
        error: Optional[BaseException] = None,
    ) -> None:
        """Record the backend used for the current video sample.

        This state describes decoder selection, rather than process memory
        usage.  A fallback is only marked when the alternate backend is
        entered after the primary backend failed before emitting a retained
        frame.
        """

        self.decoder_backend = backend
        self.last_decoder_backend = backend
        if not self.decoder_backend_history or self.decoder_backend_history[-1] != backend:
            self.decoder_backend_history.append(backend)
        if fallback:
            self.decoder_fallback = True
            if error is not None:
                self.decoder_fallback_reason = (
                    f"{type(error).__name__}: {error}"
                )

    def _reset_sampler_metrics(self) -> None:
        """Reset per-video timers without touching run-level metrics."""

        if self.metrics is None:
            self._sampler_stage_elapsed = {}
            self._sampler_stage_items = {}
            self._sampler_sampled_frames = 0
            self._sampler_retained_frames = 0
            return
        self._sampler_stage_elapsed = {name: 0.0 for name in SAMPLER_STAGE_NAMES}
        self._sampler_stage_items = {name: 0 for name in SAMPLER_STAGE_NAMES}
        self._sampler_sampled_frames = 0
        self._sampler_retained_frames = 0

    def _accumulate_sampler_stage(
        self,
        name: str,
        elapsed_seconds: float,
        items: int = 0,
    ) -> None:
        """Accumulate a stage locally; metrics are flushed once per sample."""

        if self.metrics is None:
            return
        self._sampler_stage_elapsed[name] = (
            self._sampler_stage_elapsed.get(name, 0.0) + max(0.0, float(elapsed_seconds))
        )
        self._sampler_stage_items[name] = (
            self._sampler_stage_items.get(name, 0) + max(0, int(items))
        )

    def _flush_sampler_metrics(self) -> None:
        """Write locally accumulated sampler metrics at the sampling boundary."""

        if self.metrics is None:
            return

        # ``preprocess`` is the legacy outer field. Its timers overlap the
        # granular geometry/resize stages, so consumers must not add this
        # value to the sampler_* values. ``decode_sample`` remains owned by
        # the caller's legacy outer sampling scope (for example embedder.py).
        preprocess_elapsed = (
            self._sampler_stage_elapsed.get("sampler_geometry", 0.0)
            + self._sampler_stage_elapsed.get("sampler_hash_resize", 0.0)
            + self._sampler_stage_elapsed.get("sampler_clip_prepare", 0.0)
        )
        preprocess_items = (
            self._sampler_sampled_frames + self._sampler_retained_frames
        )
        self._preprocess_elapsed_seconds = preprocess_elapsed
        self._preprocess_calls = preprocess_items
        # A zero record keeps every dynamically named stage visible even for
        # an empty stream. Batch insertion preserves one call per stage while
        # reducing the resource snapshot cost to one per sampled video.
        self.metrics.add_elapsed_batch(
            [
                *(
                    (
                        name,
                        self._sampler_stage_elapsed.get(name, 0.0),
                        self._sampler_stage_items.get(name, 0),
                    )
                    for name in SAMPLER_STAGE_NAMES
                ),
                ("preprocess", preprocess_elapsed, preprocess_items),
            ]
        )
        self.metrics.count("sampled_frames", self._sampler_sampled_frames)
        self.metrics.count("retained_frames", self._sampler_retained_frames)

    def _flush_decoder_telemetry(self) -> None:
        """Record decoder selection once after a video sample completes."""

        if self.metrics is None:
            return
        self.metrics.count(
            "decoder_opencv_videos",
            int(self.decoder_backend == DECODER_BACKEND_OPENCV),
        )
        self.metrics.count(
            "decoder_decord_videos",
            int(self.decoder_backend == DECODER_BACKEND_DECORD),
        )
        self.metrics.count("decoder_fallbacks", int(self.decoder_fallback))

    def _get_thumbnail_dir(self, video_path: Union[str, Path]) -> Path:
        """Get the thumbnail directory for a video."""
        video_stem = Path(video_path).stem
        return self.cache_dir / "frames" / video_stem

    def _frame_to_pil(self, frame: np.ndarray) -> Image.Image:
        """Convert OpenCV BGR frame to PIL RGB image."""
        # OpenCV uses BGR, PIL uses RGB
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        return Image.fromarray(rgb_frame)

    def _save_thumbnail(
        self, frame: np.ndarray, frame_index: int, thumbnail_dir: Path
    ) -> str:
        """
        Save a thumbnail of the frame.

        Args:
            frame: OpenCV BGR frame
            frame_index: Frame index for filename
            thumbnail_dir: Directory to save thumbnail

        Returns:
            Path to saved thumbnail

        Raises:
            IOError: If thumbnail cannot be saved
        """
        # Ensure parent directory exists
        thumbnail_dir.mkdir(parents=True, exist_ok=True)

        # Build thumbnail path
        thumbnail_path = thumbnail_dir / f"frame_{frame_index:06d}.jpg"

        # Use cv2.imencode + tofile to handle non-ASCII paths on Windows
        # cv2.imwrite fails with non-ASCII paths on Windows
        success, encoded = cv2.imencode(".jpg", frame)
        if not success:
            raise IOError(f"Failed to encode frame as JPEG: frame_index={frame_index}")

        # Write encoded bytes to file using tofile (handles non-ASCII paths)
        encoded.tofile(str(thumbnail_path))

        # Verify file was actually created
        if not thumbnail_path.exists():
            raise IOError(f"Thumbnail file not created: {thumbnail_path}")

        return str(thumbnail_path)

    def sample(
        self,
        video_path: Union[str, Path],
        progress_callback: Optional[Callable[[int, int, float], None]] = None,
    ) -> List[RetainedFrame]:
        """
        Sample frames dynamically from a video based on visual changes.

        The first frame is always retained. Subsequent frames are retained only
        if they are visually different from the last retained frame (similarity
        < skip_threshold) or if max_gap_sec has passed since the last retained frame.

        Args:
            video_path: Path to the video file

        Returns:
            List of RetainedFrame objects with metadata for each retained frame
        """
        retained_frames: List[RetainedFrame] = []
        self._run_sampling(
            video_path,
            progress_callback=progress_callback,
            retained_frames=retained_frames,
        )
        return retained_frames

    def sample_stream(
        self,
        video_path: Union[str, Path],
        retained_callback: Callable[[RetainedFrame], None],
        progress_callback: Optional[Callable[[int, int, float], None]] = None,
    ) -> int:
        """Emit retained frames in order without materializing the full list."""

        if not callable(retained_callback):
            raise TypeError("retained_callback must be callable")
        self._run_sampling(
            video_path,
            progress_callback=progress_callback,
            retained_callback=retained_callback,
        )
        return self.retained_count

    def _run_sampling(
        self,
        video_path: Union[str, Path],
        progress_callback: Optional[Callable[[int, int, float], None]],
        retained_frames: Optional[List[RetainedFrame]] = None,
        retained_callback: Optional[Callable[[RetainedFrame], None]] = None,
    ) -> None:
        video_path = Path(video_path)
        self.source_duration_sec = 0.0
        self._preprocess_elapsed_seconds = 0.0
        self._preprocess_calls = 0
        self._reset_sampler_metrics()
        self.retained_count = 0
        self.total_frames = 0
        # Sampling instances are reusable.  A callback failure from an
        # earlier run must not suppress the safe decoder fallback on the next
        # run.
        self._retained_callback_failed = False
        self.decoder_backend = DECODER_BACKEND_UNKNOWN
        self.last_decoder_backend = DECODER_BACKEND_UNKNOWN
        self.decoder_fallback = False
        self.decoder_fallback_reason = None
        self.decoder_backend_history = []
        try:
            if not video_path.exists():
                raise FileNotFoundError(f"Video not found: {video_path}")

            # OpenCV advances sequentially and keeps only the current decoded
            # frame alive. This is the safe default for frame_step=1: Decord's
            # get_batch/asnumpy path can retain decoder-owned native buffers as
            # batches progress, allowing RSS to grow substantially for
            # portrait/high-resolution videos. The same order is retained
            # for sparse frame_step values, where OpenCV already was primary.
            try:
                self._mark_decoder_backend(DECODER_BACKEND_OPENCV)
                self._sample_with_opencv(
                    video_path, progress_callback, retained_frames, retained_callback
                )
            except Exception as opencv_error:
                # Never restart a partially emitted stream: doing so would
                # duplicate callback output and can corrupt the cache.
                if (
                    self._retained_callback_failed
                    or self.retained_count > 0
                    or (retained_frames is not None and len(retained_frames) > 0)
                ):
                    raise
                self._mark_decoder_backend(
                    DECODER_BACKEND_DECORD,
                    fallback=True,
                    error=opencv_error,
                )
                print(
                    f"警告(Warning): OpenCV 顺序帧读取器读取失败 {video_path.resolve()}，改用 Decord: {opencv_error}"
                )
                self._sample_with_decord(
                    video_path, progress_callback, retained_frames, retained_callback
                )
        finally:
            self._flush_decoder_telemetry()
            self._flush_sampler_metrics()

    def _sample_with_decord(
        self,
        video_path: Path,
        progress_callback: Optional[Callable[[int, int, float], None]] = None,
        retained_frames: Optional[List[RetainedFrame]] = None,
        retained_callback: Optional[Callable[[RetainedFrame], None]] = None,
    ) -> List[RetainedFrame]:
        """Sample frames with Decord as the guarded OpenCV fallback."""
        self._mark_decoder_backend(DECODER_BACKEND_DECORD)
        decode_open_started = time.perf_counter() if self.metrics is not None else 0.0
        try:
            vr = VideoReader(str(video_path), ctx=cpu(0), num_threads=1)
        finally:
            if self.metrics is not None:
                self._accumulate_sampler_stage(
                    "sampler_decode",
                    time.perf_counter() - decode_open_started,
                )
        total_frames = len(vr)
        self.total_frames = total_frames
        if total_frames <= 0:
            return []

        fps = float(vr.get_avg_fps() or 0)
        if fps <= 0:
            fps = 30.0
        self.source_duration_sec = total_frames / fps

        max_gap_frames = max(1, int(self.max_gap_sec * fps))
        notify_interval = max(1, int(fps * 2))
        last_retained_hash: Optional[imagehash.ImageHash] = None
        last_retained_index = -max_gap_frames - 1
        last_notified_index = -notify_interval

        for frame_index, frame in self._iter_decord_bgr_frames(vr, total_frames):
            timestamp = frame_index / fps
            last_retained_hash, last_retained_index = self._consider_frame(
                frame=frame,
                frame_index=frame_index,
                timestamp=timestamp,
                retained_frames=retained_frames,
                last_retained_hash=last_retained_hash,
                last_retained_index=last_retained_index,
                max_gap_frames=max_gap_frames,
                video_path=video_path,
                retained_callback=retained_callback,
            )

            if (
                progress_callback
                and frame_index - last_notified_index >= notify_interval
            ):
                progress_callback(frame_index, total_frames, timestamp)
                last_notified_index = frame_index

        if progress_callback:
            progress_callback(total_frames, total_frames, total_frames / fps)

        if self.retained_count == 0 and total_frames > 0:
            raise ValueError("Decord decoded no usable frames")

        return retained_frames or []

    def _iter_decord_bgr_frames(
        self,
        vr: VideoReader,
        total_frames: int,
        chunk_size: Optional[int] = None,
    ) -> Iterable[Tuple[int, np.ndarray]]:
        step = max(1, self.frame_step)

        # Decord does not expose frame geometry consistently across versions.
        # Probe one frame when possible, then turn the byte budget into a
        # sampled-frame count. If probing fails we use one frame conservatively
        # and retain the existing per-frame fallback for decode errors.
        frame_shape: Optional[Tuple[int, ...]] = None
        prefetched_rgb_frame: Optional[np.ndarray] = None
        if total_frames > 0:
            decode_started = time.perf_counter() if self.metrics is not None else 0.0
            try:
                prefetched_rgb_frame = np.asarray(vr[0].asnumpy())
                frame_shape = tuple(prefetched_rgb_frame.shape)
            except Exception:
                frame_shape = None
                prefetched_rgb_frame = None
            finally:
                if self.metrics is not None:
                    self._accumulate_sampler_stage(
                        "sampler_decode",
                        time.perf_counter() - decode_started,
                        items=1 if prefetched_rgb_frame is not None else 0,
                    )
        budget_bytes = parse_decode_batch_bytes()
        batch_size = decode_batch_size_for_frame_shape(frame_shape, budget_bytes)
        # ``chunk_size`` remains an internal compatibility hook for focused
        # callers, but the normal path is governed by the byte budget.
        if chunk_size is not None:
            batch_size = min(batch_size, max(1, int(chunk_size)))
        self.last_decode_batch_size = batch_size
        self.last_decode_frame_bytes = _decoded_frame_bytes(frame_shape) or None
        self.last_decode_batch_oversized = bool(
            self.last_decode_frame_bytes is not None
            and self.last_decode_frame_bytes > budget_bytes
        )
        chunk_span = step * batch_size

        for chunk_start in range(0, total_frames, chunk_span):
            indices = list(range(chunk_start, min(total_frames, chunk_start + chunk_span), step))
            if not indices:
                continue

            batch_indices = indices
            prefetched_bgr_frame: Optional[np.ndarray] = None
            if chunk_start == 0 and indices[0] == 0 and prefetched_rgb_frame is not None:
                color_started = time.perf_counter() if self.metrics is not None else 0.0
                try:
                    prefetched_bgr_frame = _rgb_to_bgr(prefetched_rgb_frame)
                except Exception:
                    # Keep frame zero in the batch when the probe cannot be
                    # converted; the normal batch or scalar fallback may
                    # still decode a usable representation.
                    prefetched_bgr_frame = None
                else:
                    # The probe already decoded frame zero. Exclude it from
                    # the first batch, and emit it first to preserve order.
                    batch_indices = indices[1:]
                    prefetched_rgb_frame = None
                    if self.metrics is not None:
                        self._accumulate_sampler_stage(
                            "sampler_color_convert",
                            time.perf_counter() - color_started,
                            items=1,
                        )
                    yield 0, prefetched_bgr_frame
                if self.metrics is not None and prefetched_bgr_frame is None:
                    self._accumulate_sampler_stage(
                        "sampler_color_convert",
                        time.perf_counter() - color_started,
                    )

            if not batch_indices:
                # Avoid calling get_batch([]) when the first chunk contains
                # only the prefetched frame.
                continue

            decode_started = time.perf_counter() if self.metrics is not None else 0.0
            try:
                batch = vr.get_batch(batch_indices).asnumpy()
            except Exception:
                if self.metrics is not None:
                    self._accumulate_sampler_stage(
                        "sampler_decode",
                        time.perf_counter() - decode_started,
                    )
                for index in batch_indices:
                    scalar_decode_started = time.perf_counter() if self.metrics is not None else 0.0
                    try:
                        rgb_frame = vr[index].asnumpy()
                    except Exception:
                        if self.metrics is not None:
                            self._accumulate_sampler_stage(
                                "sampler_decode",
                                time.perf_counter() - scalar_decode_started,
                            )
                        continue
                    if self.metrics is not None:
                        self._accumulate_sampler_stage(
                            "sampler_decode",
                            time.perf_counter() - scalar_decode_started,
                            items=1,
                        )
                    scalar_color_started = time.perf_counter() if self.metrics is not None else 0.0
                    try:
                        bgr_frame = _rgb_to_bgr(rgb_frame)
                    except Exception:
                        if self.metrics is not None:
                            self._accumulate_sampler_stage(
                                "sampler_color_convert",
                                time.perf_counter() - scalar_color_started,
                            )
                        continue
                    if self.metrics is not None:
                        self._accumulate_sampler_stage(
                            "sampler_color_convert",
                            time.perf_counter() - scalar_color_started,
                            items=1,
                        )
                    yield index, bgr_frame
                continue
            if self.metrics is not None:
                self._accumulate_sampler_stage(
                    "sampler_decode",
                    time.perf_counter() - decode_started,
                    items=len(batch_indices),
                )

            for index, rgb_frame in zip(batch_indices, batch):
                color_started = time.perf_counter() if self.metrics is not None else 0.0
                try:
                    bgr_frame = _rgb_to_bgr(rgb_frame)
                finally:
                    if self.metrics is not None:
                        self._accumulate_sampler_stage(
                            "sampler_color_convert",
                            time.perf_counter() - color_started,
                            items=1,
                        )
                yield index, bgr_frame

    def _sample_with_opencv(
        self,
        video_path: Path,
        progress_callback: Optional[Callable[[int, int, float], None]] = None,
        retained_frames: Optional[List[RetainedFrame]] = None,
        retained_callback: Optional[Callable[[RetainedFrame], None]] = None,
    ) -> List[RetainedFrame]:
        self._mark_decoder_backend(DECODER_BACKEND_OPENCV)
        # Open video with OpenCV
        decode_open_started = time.perf_counter() if self.metrics is not None else 0.0
        try:
            cap = cv2.VideoCapture(str(video_path))
            opened = cap.isOpened()
        finally:
            if self.metrics is not None:
                self._accumulate_sampler_stage(
                    "sampler_decode",
                    time.perf_counter() - decode_open_started,
                )
        if not opened:
            raise ValueError(f"Cannot open video: {video_path}")

        # Get video properties
        fps = cap.get(cv2.CAP_PROP_FPS)
        if fps <= 0:
            fps = 30.0  # Default fallback

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        self.total_frames = total_frames
        self.source_duration_sec = total_frames / fps if total_frames > 0 else 0.0
        max_gap_frames = max(1, int(self.max_gap_sec * fps))
        notify_interval = max(1, int(fps * 2))
        last_retained_hash: Optional[imagehash.ImageHash] = None
        last_retained_index = -max_gap_frames - 1  # Ensure first frame is retained
        frame_index = 0
        read_failures = 0

        try:
            while True:
                decode_started = time.perf_counter() if self.metrics is not None else 0.0
                ret, frame = cap.read()
                if self.metrics is not None:
                    self._accumulate_sampler_stage(
                        "sampler_decode",
                        time.perf_counter() - decode_started,
                        items=1 if ret and frame is not None and frame.size else 0,
                    )
                if not ret or frame is None or frame.size == 0:
                    read_failures += 1
                    if total_frames > 0 and read_failures < 25 and frame_index + self.frame_step < total_frames:
                        seek_started = time.perf_counter() if self.metrics is not None else 0.0
                        frame_index += self.frame_step
                        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
                        if self.metrics is not None:
                            self._accumulate_sampler_stage(
                                "sampler_decode",
                                time.perf_counter() - seek_started,
                            )
                        continue
                    break
                read_failures = 0

                # Compute timestamp
                timestamp = frame_index / fps

                last_retained_hash, last_retained_index = self._consider_frame(
                    frame=frame,
                    frame_index=frame_index,
                    timestamp=timestamp,
                    retained_frames=retained_frames,
                    last_retained_hash=last_retained_hash,
                    last_retained_index=last_retained_index,
                    max_gap_frames=max_gap_frames,
                    video_path=video_path,
                    retained_callback=retained_callback,
                )

                if progress_callback and frame_index % notify_interval == 0:
                    progress_callback(frame_index, total_frames, timestamp)

                next_frame_index = frame_index + 1
                reached_end = False
                for _ in range(self.frame_step - 1):
                    grab_started = time.perf_counter() if self.metrics is not None else 0.0
                    if not cap.grab():
                        if self.metrics is not None:
                            self._accumulate_sampler_stage(
                                "sampler_decode",
                                time.perf_counter() - grab_started,
                            )
                        reached_end = True
                        break
                    if self.metrics is not None:
                        self._accumulate_sampler_stage(
                            "sampler_decode",
                            time.perf_counter() - grab_started,
                            items=1,
                        )
                    next_frame_index += 1
                frame_index = next_frame_index
                if reached_end:
                    break
        finally:
            cap.release()

        if progress_callback:
            progress_callback(frame_index, total_frames, frame_index / fps if fps > 0 else 0.0)

        if self.retained_count == 0 and total_frames > 0:
            raise ValueError("OpenCV decoded no usable frames")

        return retained_frames or []

    def _consider_frame(
        self,
        frame: np.ndarray,
        frame_index: int,
        timestamp: float,
        retained_frames: Optional[List[RetainedFrame]],
        last_retained_hash: Optional[imagehash.ImageHash],
        last_retained_index: int,
        max_gap_frames: int,
        video_path: Path,
        retained_callback: Optional[Callable[[RetainedFrame], None]] = None,
    ) -> Tuple[Optional[imagehash.ImageHash], int]:
        metrics_enabled = self.metrics is not None
        if metrics_enabled:
            self._sampler_sampled_frames += 1

        # Prepare geometry exactly once per candidate. The prepared result is
        # a read-only view when no rotation allocates a new array. Hash and
        # CLIP then resize this same geometry independently with their legacy
        # interpolation methods (INTER_AREA and INTER_LINEAR respectively).
        geometry_started = time.perf_counter() if metrics_enabled else 0.0
        prepared = prepare_frame_geometry(frame, self.preprocess_config)
        if metrics_enabled:
            self._accumulate_sampler_stage(
                "sampler_geometry",
                time.perf_counter() - geometry_started,
                items=1,
            )

        target_size = max(1, int(self.preprocess_config.input_size))
        if prepared.shape[0] != target_size or prepared.shape[1] != target_size:
            hash_resize_started = time.perf_counter() if metrics_enabled else 0.0
            hash_frame = resize_prepared_frame(
                prepared,
                target_size=target_size,
                mode=self.preprocess_config.resize_mode,
                interpolation=cv2.INTER_AREA,
            )
            if metrics_enabled:
                self._accumulate_sampler_stage(
                    "sampler_hash_resize",
                    time.perf_counter() - hash_resize_started,
                    items=1,
                )
        else:
            # The old public hash path skipped resize for an already square
            # target frame. Keep that behavior while retaining a private copy
            # boundary for the hash consumer.
            hash_frame = prepared

        hash_color_started = time.perf_counter() if metrics_enabled else 0.0
        hash_rgb = cv2.cvtColor(hash_frame, cv2.COLOR_BGR2RGB)
        if metrics_enabled:
            self._accumulate_sampler_stage(
                "sampler_color_convert",
                time.perf_counter() - hash_color_started,
                items=1,
            )

        phash_started = time.perf_counter() if metrics_enabled else 0.0
        pil_image = Image.fromarray(hash_rgb)
        current_hash = imagehash.phash(pil_image)
        if metrics_enabled:
            self._accumulate_sampler_stage(
                "sampler_phash",
                time.perf_counter() - phash_started,
                items=1,
            )

        # Decision: retain or skip
        should_retain = False

        if last_retained_hash is None:
            # First frame: always retain
            should_retain = True
        else:
            # Check gap constraint
            gap = frame_index - last_retained_index
            if gap >= max_gap_frames:
                # Force retain due to max_gap_sec
                should_retain = True
            else:
                # Check visual similarity
                similarity = compute_phash_similarity(
                    last_retained_hash, current_hash
                )
                if similarity < self.skip_threshold:
                    # Frame is visually different, retain it
                    should_retain = True

        if should_retain:
            # Keep the compact preprocessed RGB frame in memory for embedding.
            # The UI uses timestamps to seek in the original videos, so no
            # thumbnail files are needed.
            if prepared.shape[0] != target_size or prepared.shape[1] != target_size:
                clip_prepare_started = time.perf_counter() if metrics_enabled else 0.0
                clip_bgr = resize_prepared_frame(
                    prepared,
                    target_size=target_size,
                    mode=self.preprocess_config.resize_mode,
                    interpolation=cv2.INTER_LINEAR,
                )
                if metrics_enabled:
                    self._accumulate_sampler_stage(
                        "sampler_clip_prepare",
                        time.perf_counter() - clip_prepare_started,
                        items=1,
                    )
            else:
                clip_bgr = prepared

            clip_color_started = time.perf_counter() if metrics_enabled else 0.0
            clip_frame = cv2.cvtColor(clip_bgr, cv2.COLOR_BGR2RGB)
            if metrics_enabled:
                self._accumulate_sampler_stage(
                    "sampler_color_convert",
                    time.perf_counter() - clip_color_started,
                    items=1,
                )
            retained_frame = RetainedFrame(
                video_path=str(video_path),
                frame_index=frame_index,
                timestamp=timestamp,
                phash=str(current_hash),
                clip_frame=clip_frame,
            )
            if retained_frames is not None:
                retained_frames.append(retained_frame)
            self.retained_count += 1
            if metrics_enabled:
                self._sampler_retained_frames += 1
            if retained_callback is not None:
                self._retained_callback_failed = True
                callback_started = time.perf_counter() if metrics_enabled else 0.0
                try:
                    retained_callback(retained_frame)
                finally:
                    if metrics_enabled:
                        self._accumulate_sampler_stage(
                            "sampler_callback",
                            time.perf_counter() - callback_started,
                            items=1,
                        )
                self._retained_callback_failed = False

            # Update state
            last_retained_hash = current_hash
            last_retained_index = frame_index

        return last_retained_hash, last_retained_index


def dynamic_sample_frames(
    video_path: Union[str, Path],
    skip_threshold: float = 0.90,
    max_gap_sec: float = 5.0,
    frame_step: int = 1,
    cache_dir: Union[str, Path] = "data",
    preprocess_config: Optional[PreprocessConfig] = None,
) -> List[RetainedFrame]:
    """
    Convenience function for dynamic frame sampling.

    Args:
        video_path: Path to the video file
        skip_threshold: Frames with similarity >= this value are skipped
        max_gap_sec: Maximum seconds between retained frames
        frame_step: Analyze every Nth frame. 1 means every frame.
        cache_dir: Base directory for caching frames/thumbnails
        preprocess_config: Configuration for frame preprocessing (optional)

    Returns:
        List of RetainedFrame objects
    """
    sampler = DynamicFrameSampler(
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
        cache_dir=cache_dir,
        preprocess_config=preprocess_config,
    )
    return sampler.sample(video_path)


def _rgb_to_bgr(frame: np.ndarray) -> np.ndarray:
    frame = np.asarray(frame)
    # Decord normally provides uint8 RGB. Avoid an unnecessary full-frame
    # astype allocation on this hot path; cvtColor already returns a fresh BGR
    # array. Keep the historical cast for all other dtypes and channel forms.
    converted = frame if frame.dtype == np.uint8 else frame.astype(np.uint8)
    if frame.ndim == 2:
        return cv2.cvtColor(converted, cv2.COLOR_GRAY2BGR)
    if frame.shape[-1] == 4:
        return cv2.cvtColor(converted, cv2.COLOR_RGBA2BGR)
    if frame.shape[-1] == 3:
        return cv2.cvtColor(converted, cv2.COLOR_RGB2BGR)
    raise ValueError(f"Unsupported decoded frame shape: {frame.shape}")
