"""
Frame sampling module for video similarity search.

Provides adaptive and uniform frame sampling using decord for efficient
video frame extraction, and dynamic frame sampling based on perceptual hashing.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, List, Optional, Tuple, Union

os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")

import cv2
import imagehash
import numpy as np
from PIL import Image
from decord import VideoReader, cpu

from video_sim.preprocess import (
    PreprocessConfig,
    preprocess_frame_for_clip,
    preprocess_frame_for_hash,
)

try:
    cv2.setLogLevel(0)
except Exception:
    pass


@dataclass
class RetainedFrame:
    """Information about a retained frame from dynamic sampling."""
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
        video_path = Path(video_path)
        if not video_path.exists():
            raise FileNotFoundError(f"Video not found: {video_path}")

        try:
            return self._sample_with_decord(video_path, progress_callback)
        except Exception as decord_error:
            print(
                f"Warning: Decord frame reader failed for {video_path.resolve()}; "
                f"falling back to OpenCV: {decord_error}"
            )
            return self._sample_with_opencv(video_path, progress_callback)

    def _sample_with_decord(
        self,
        video_path: Path,
        progress_callback: Optional[Callable[[int, int, float], None]] = None,
    ) -> List[RetainedFrame]:
        """Sample frames with Decord first to avoid OpenCV swscaler noise."""
        vr = VideoReader(str(video_path), ctx=cpu(0), num_threads=1)
        total_frames = len(vr)
        if total_frames <= 0:
            return []

        fps = float(vr.get_avg_fps() or 0)
        if fps <= 0:
            fps = 30.0

        max_gap_frames = max(1, int(self.max_gap_sec * fps))
        notify_interval = max(1, int(fps * 2))
        retained_frames: List[RetainedFrame] = []
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
            )

            if (
                progress_callback
                and frame_index - last_notified_index >= notify_interval
            ):
                progress_callback(frame_index, total_frames, timestamp)
                last_notified_index = frame_index

        if progress_callback:
            progress_callback(total_frames, total_frames, total_frames / fps)

        if not retained_frames and total_frames > 0:
            raise ValueError("Decord decoded no usable frames")

        return retained_frames

    def _iter_decord_bgr_frames(
        self,
        vr: VideoReader,
        total_frames: int,
        chunk_size: int = 64,
    ) -> Iterable[Tuple[int, np.ndarray]]:
        step = max(1, self.frame_step)
        chunk_span = step * max(1, chunk_size)

        for chunk_start in range(0, total_frames, chunk_span):
            indices = list(range(chunk_start, min(total_frames, chunk_start + chunk_span), step))
            if not indices:
                continue

            try:
                batch = vr.get_batch(indices).asnumpy()
            except Exception:
                for index in indices:
                    try:
                        yield index, _rgb_to_bgr(vr[index].asnumpy())
                    except Exception:
                        continue
                continue

            for index, rgb_frame in zip(indices, batch):
                yield index, _rgb_to_bgr(rgb_frame)

    def _sample_with_opencv(
        self,
        video_path: Path,
        progress_callback: Optional[Callable[[int, int, float], None]] = None,
    ) -> List[RetainedFrame]:
        # Open video with OpenCV
        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise ValueError(f"Cannot open video: {video_path}")

        # Get video properties
        fps = cap.get(cv2.CAP_PROP_FPS)
        if fps <= 0:
            fps = 30.0  # Default fallback

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        max_gap_frames = max(1, int(self.max_gap_sec * fps))
        notify_interval = max(1, int(fps * 2))
        retained_frames: List[RetainedFrame] = []
        last_retained_hash: Optional[imagehash.ImageHash] = None
        last_retained_index = -max_gap_frames - 1  # Ensure first frame is retained
        frame_index = 0
        read_failures = 0

        try:
            while True:
                ret, frame = cap.read()
                if not ret or frame is None or frame.size == 0:
                    read_failures += 1
                    if total_frames > 0 and read_failures < 25 and frame_index + self.frame_step < total_frames:
                        frame_index += self.frame_step
                        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
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
                )

                if progress_callback and frame_index % notify_interval == 0:
                    progress_callback(frame_index, total_frames, timestamp)

                next_frame_index = frame_index + 1
                reached_end = False
                for _ in range(self.frame_step - 1):
                    if not cap.grab():
                        reached_end = True
                        break
                    next_frame_index += 1
                frame_index = next_frame_index
                if reached_end:
                    break
        finally:
            cap.release()

        if progress_callback:
            progress_callback(frame_index, total_frames, frame_index / fps if fps > 0 else 0.0)

        return retained_frames

    def _consider_frame(
        self,
        frame: np.ndarray,
        frame_index: int,
        timestamp: float,
        retained_frames: List[RetainedFrame],
        last_retained_hash: Optional[imagehash.ImageHash],
        last_retained_index: int,
        max_gap_frames: int,
        video_path: Path,
    ) -> Tuple[Optional[imagehash.ImageHash], int]:
        # Preprocess frame for hash computation
        preprocessed = preprocess_frame_for_hash(frame, self.preprocess_config)

        # Convert to PIL and compute pHash
        pil_image = Image.fromarray(cv2.cvtColor(preprocessed, cv2.COLOR_BGR2RGB))
        current_hash = imagehash.phash(pil_image)

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
            clip_frame = preprocess_frame_for_clip(frame, self.preprocess_config)
            clip_frame = cv2.cvtColor(clip_frame, cv2.COLOR_BGR2RGB)
            retained_frame = RetainedFrame(
                video_path=str(video_path),
                frame_index=frame_index,
                timestamp=timestamp,
                phash=str(current_hash),
                clip_frame=clip_frame,
            )
            retained_frames.append(retained_frame)

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
    if frame.ndim == 2:
        return cv2.cvtColor(frame.astype(np.uint8), cv2.COLOR_GRAY2BGR)
    if frame.shape[-1] == 4:
        return cv2.cvtColor(frame.astype(np.uint8), cv2.COLOR_RGBA2BGR)
    if frame.shape[-1] == 3:
        return cv2.cvtColor(frame.astype(np.uint8), cv2.COLOR_RGB2BGR)
    raise ValueError(f"Unsupported decoded frame shape: {frame.shape}")
