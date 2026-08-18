"""
Video embedding module for video similarity search.

Provides video embedding using CLIP model for image representation.

Supports both:
- Video-level embedding (average of frame embeddings)
- Frame-level embedding (one embedding per frame)
"""

from contextlib import ExitStack, nullcontext, redirect_stderr
from dataclasses import dataclass
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import queue
import threading
import time
from typing import Callable, Dict, Iterable, List, Optional, Union
import warnings

import numpy as np
import torch
from PIL import Image

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TRANSFORMERS_NO_TF", "1")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

from video_sim.preprocess import PreprocessConfig, preprocess_frame_for_clip
from video_sim.metrics import RecognitionMetrics
from video_sim.model_locator import (
    DEFAULT_EMBEDDING_MODEL,
    embedding_model_fingerprint,
    resolve_embedding_model_source,
)

FRAME_CACHE_SCHEMA_VERSION = 4


def _nested_context(*contexts):
    stack = ExitStack()
    for context in contexts:
        stack.enter_context(context)
    return stack


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _normalise_autocast_dtype(value: Optional[str]) -> str:
    name = (value or os.environ.get("VIDEO_SIM_CLIP_AUTOCAST_DTYPE", "float16")).strip().lower()
    if name in {"bf16", "bfloat16"}:
        return "bfloat16"
    return "float16"


def embedding_runtime_fingerprint(
    device: Optional[str] = None,
    autocast_enabled: Optional[bool] = None,
    autocast_dtype: Optional[str] = None,
) -> str:
    """Return the inference runtime identity used in cache validation.

    Autocast is opt-in (``VIDEO_SIM_CLIP_AUTOCAST=1``) to preserve the
    existing FP32 accuracy contract by default.  Only the numerical
    precision mode is part of this identity.  Device and PyTorch patch
    versions do not change cache semantics, so compatible FP32 caches can be
    reused between CPU and GPU and across torch upgrades.  Model weights and
    preprocessing configuration have their own cache fingerprints.
    """

    resolved_device = str(device or ("cuda" if torch.cuda.is_available() else "cpu")).lower()
    requested = _env_flag("VIDEO_SIM_CLIP_AUTOCAST", False) if autocast_enabled is None else bool(autocast_enabled)
    enabled = requested and resolved_device.startswith("cuda") and torch.cuda.is_available()
    dtype = _normalise_autocast_dtype(autocast_dtype)
    if enabled and dtype == "bfloat16":
        try:
            if not torch.cuda.is_bf16_supported():
                dtype = "float16"
        except Exception:
            dtype = "float16"
    if not enabled:
        dtype = "float32"
    precision = dtype if enabled else "float32"
    precision_name = {
        "float16": "fp16",
        "bfloat16": "bf16",
        "float32": "fp32",
    }[precision]
    return f"precision={precision_name}"


def frames_to_pil(frames: np.ndarray) -> List[Image.Image]:
    """
    Convert numpy frames to PIL images.

    Args:
        frames: numpy array of shape (N, H, W, 3) dtype uint8

    Returns:
        List of PIL Images
    """
    return [Image.fromarray(f) for f in frames]


def l2_normalize(embeddings: np.ndarray) -> np.ndarray:
    """
    L2 normalize embeddings along the last axis.

    Args:
        embeddings: numpy array of shape (..., D)

    Returns:
        L2 normalized embeddings of the same shape
    """
    norms = np.linalg.norm(embeddings, axis=-1, keepdims=True)
    # Avoid division by zero
    norms = np.where(norms == 0, 1.0, norms)
    return embeddings / norms


class VideoEmbedder:
    """
    Video embedding class using CLIP model.

    Uses CLIP (512-dim) for image/visual embedding.
    """

    def __init__(
        self,
        device: Optional[str] = None,
        num_frames: int = 16,
        preprocess_config: Optional[PreprocessConfig] = None,
        autocast_enabled: Optional[bool] = None,
        autocast_dtype: Optional[str] = None,
        metrics: Optional[RecognitionMetrics] = None,
    ):
        """
        Initialize the video embedder.

        Args:
            device: Device to use ('cuda' or 'cpu'). Auto-detected if None.
            num_frames: Number of frames to use for video-level embedding (unused for frame-level)
            preprocess_config: Configuration for frame preprocessing (optional)
        """
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.num_frames = num_frames
        self.preprocess_config = preprocess_config or PreprocessConfig()
        requested_autocast = _env_flag("VIDEO_SIM_CLIP_AUTOCAST", False) if autocast_enabled is None else bool(autocast_enabled)
        self.autocast_enabled = bool(
            requested_autocast
            and str(self.device).lower().startswith("cuda")
            and torch.cuda.is_available()
        )
        self.autocast_dtype_name = _normalise_autocast_dtype(autocast_dtype)
        if self.autocast_enabled and self.autocast_dtype_name == "bfloat16":
            try:
                if not torch.cuda.is_bf16_supported():
                    self.autocast_dtype_name = "float16"
            except Exception:
                self.autocast_dtype_name = "float16"
        self.autocast_dtype = (
            torch.bfloat16 if self.autocast_dtype_name == "bfloat16" else torch.float16
        )
        self.metrics = metrics
        self.last_batch_sizes: List[int] = []
        self._load_models()

    def embedding_runtime_fingerprint(self) -> str:
        """Return this embedder's cache/runtime identity."""

        return embedding_runtime_fingerprint(
            device=self.device,
            autocast_enabled=self.autocast_enabled,
            autocast_dtype=self.autocast_dtype_name,
        )

    def _inference_context(self):
        """Use inference mode and opt-in CUDA autocast for model execution."""

        if self.autocast_enabled:
            return _nested_context(torch.inference_mode(), torch.autocast(
                device_type="cuda",
                dtype=self.autocast_dtype,
            ))
        return torch.inference_mode()

    def _prepare_images(
        self,
        frames: np.ndarray,
        *,
        frames_are_preprocessed: bool = False,
    ) -> List[Image.Image]:
        """Convert raw or prepared RGB frames to PIL exactly once."""

        array = np.asarray(frames, dtype="uint8")
        if array.ndim != 4 or array.shape[-1] != 3:
            raise ValueError("Expected frames with shape (N, H, W, 3)")
        if frames_are_preprocessed:
            return frames_to_pil(array)
        return [
            Image.fromarray(preprocess_frame_for_clip(frame, self.preprocess_config))
            for frame in array
        ]

    @staticmethod
    def _is_cuda_oom(error: BaseException, device: str) -> bool:
        if not str(device).lower().startswith("cuda"):
            return False
        if "out of memory" in str(error).lower():
            return True
        try:
            return isinstance(error, torch.cuda.OutOfMemoryError)
        except AttributeError:
            return False

    def _load_models(self) -> None:
        """Load CLIP model."""
        from transformers import CLIPVisionModel
        from transformers.utils import logging as transformers_logging

        try:
            from transformers import CLIPImageProcessorPil as ClipImageProcessor
        except ImportError:
            from transformers import CLIPImageProcessor as ClipImageProcessor

        transformers_logging.set_verbosity_error()
        logging.getLogger("transformers").setLevel(logging.ERROR)
        logging.getLogger("huggingface_hub").setLevel(logging.ERROR)
        logging.getLogger("huggingface_hub.utils._auth").setLevel(logging.ERROR)
        warnings.filterwarnings("ignore", message=r".*requires torchvision.*")
        warnings.filterwarnings("ignore", message=r".*unauthenticated requests to the HF Hub.*")

        torch_threads = os.environ.get("TORCH_NUM_THREADS", "").strip()
        if torch_threads.isdigit():
            torch.set_num_threads(max(1, int(torch_threads)))

        model_source = resolve_embedding_model_source()
        local_model = isinstance(model_source, Path)
        print(
            f"正在 {self.device} 上加载 CLIP 模型(Loading CLIP model on {self.device})："
            f"{model_source if local_model else DEFAULT_EMBEDDING_MODEL}..."
        )
        captured_stderr = io.StringIO()
        try:
            with redirect_stderr(captured_stderr):
                self.clip_processor = ClipImageProcessor.from_pretrained(
                    str(model_source),
                    local_files_only=local_model,
                )
                self.clip_model = CLIPVisionModel.from_pretrained(
                    str(model_source),
                    local_files_only=local_model,
                ).to(self.device)
        except Exception as exc:
            details = captured_stderr.getvalue().strip().splitlines()[-5:]
            detail_text = "\n".join(details)
            if detail_text:
                raise RuntimeError(f"Failed to load CLIP model: {exc}\n{detail_text}") from exc
            raise RuntimeError(f"Failed to load CLIP model: {exc}") from exc
        self.clip_model.eval()

    def embed(self, frames: np.ndarray) -> np.ndarray:
        """
        Embed video frames into a single vector.

        Uses CLIP (512-dim) to embed frames and averages them.

        Args:
            frames: numpy array of shape (N, H, W, 3)

        Returns:
            1D numpy array of shape (512,) with dtype float32, L2 normalized
        """
        frames = np.asarray(frames, dtype="uint8")

        if len(frames) == 0:
            raise ValueError(
                "No frames provided to embed. Video might be empty or unreadable."
            )

        if self.metrics is not None:
            with self.metrics.stage("preprocess", items=len(frames)):
                pil_frames = self._prepare_images(frames)
        else:
            pil_frames = self._prepare_images(frames)

        # Sample frames if we have more than needed
        if len(pil_frames) > self.num_frames:
            indices = np.linspace(0, len(pil_frames) - 1, self.num_frames).astype(int)
            pil_frames = [pil_frames[i] for i in indices]
        elif len(pil_frames) < self.num_frames:
            # Pad by duplicating the last frame
            while len(pil_frames) < self.num_frames:
                pil_frames.append(pil_frames[-1])

        embed_context = self.metrics.stage("embed", items=len(pil_frames)) if self.metrics is not None else nullcontext()
        with embed_context:
            with self._inference_context():
                # CLIP Embedding
                clip_inputs = self.clip_processor(images=pil_frames, return_tensors="pt").to(
                    self.device
                )
                clip_outputs = self.clip_model(**clip_inputs)
                clip_emb = clip_outputs.pooler_output.mean(dim=0).detach().float().cpu().numpy()

        # L2 normalize
        clip_emb = l2_normalize(clip_emb)

        return clip_emb.astype("float32")

    def embed_single_frame(self, frame: np.ndarray) -> np.ndarray:
        """
        Embed a single frame into a vector.

        Unlike embed(), this method does not average multiple frames.
        Each frame gets its own independent embedding.

        Args:
            frame: numpy array of shape (H, W, 3) dtype uint8

        Returns:
            1D numpy array of shape (512,) with dtype float32, L2 normalized
        """
        frame = np.asarray(frame, dtype="uint8")

        # Preprocess frame for CLIP
        if self.metrics is not None:
            with self.metrics.stage("preprocess", items=1):
                pil_frame = self._prepare_images(frame[None, ...])[0]
        else:
            pil_frame = self._prepare_images(frame[None, ...])[0]

        embed_context = self.metrics.stage("embed", items=1) if self.metrics is not None else nullcontext()
        with embed_context:
            with self._inference_context():
                # CLIP Embedding for single frame
                clip_inputs = self.clip_processor(images=[pil_frame], return_tensors="pt").to(
                    self.device
                )
                clip_outputs = self.clip_model(**clip_inputs)
                clip_emb = clip_outputs.pooler_output[0].detach().float().cpu().numpy()

        # L2 normalize
        clip_emb = l2_normalize(clip_emb)

        return clip_emb.astype("float32")

    def embed_frames_batch(
        self,
        frames: np.ndarray,
        batch_size: int = 32,
        progress_callback: Optional[Callable[[int, int], None]] = None,
        frames_are_preprocessed: bool = False,
    ) -> np.ndarray:
        """
        Embed multiple frames, returning one embedding per frame.

        Unlike embed(), this does not average frame embeddings.
        Each frame gets its own independent embedding.

        Args:
            frames: numpy array of shape (N, H, W, 3) dtype uint8
            frames_are_preprocessed: True when frames are RGB CLIP-sized pixels
                produced by DynamicFrameSampler; skips geometric preprocessing.

        Returns:
            2D numpy array of shape (N, 512) with dtype float32, L2 normalized
        """
        frames = np.asarray(frames, dtype="uint8")

        if len(frames) == 0:
            return np.zeros((0, 512), dtype="float32")

        batch_size = max(1, int(batch_size))
        current_batch_size = batch_size
        self.last_batch_sizes = []
        embeddings = []
        total = len(frames)

        start = 0
        while start < total:
            active_size = min(current_batch_size, total - start)
            batch = frames[start:start + active_size]
            try:
                if self.metrics is not None:
                    with self.metrics.stage("preprocess", items=len(batch)) if not frames_are_preprocessed else nullcontext():
                        pil_frames = self._prepare_images(batch, frames_are_preprocessed=frames_are_preprocessed)
                else:
                    pil_frames = self._prepare_images(batch, frames_are_preprocessed=frames_are_preprocessed)

                embed_context = self.metrics.stage("embed", items=len(batch)) if self.metrics is not None else nullcontext()
                with embed_context:
                    with self._inference_context():
                        clip_inputs = self.clip_processor(images=pil_frames, return_tensors="pt").to(
                            self.device
                        )
                        clip_outputs = self.clip_model(**clip_inputs)
                        batch_embs = clip_outputs.pooler_output.detach().float().cpu().numpy()
            except RuntimeError as error:
                if not self._is_cuda_oom(error, self.device) or active_size <= 1:
                    raise
                current_batch_size = max(1, active_size // 2)
                if self.metrics is not None:
                    self.metrics.count("embedding_oom_retries")
                # Only an actual CUDA OOM is allowed to trigger cache cleanup.
                torch.cuda.empty_cache()
                continue

            embeddings.append(batch_embs)
            self.last_batch_sizes.append(len(batch))
            if self.metrics is not None:
                self.metrics.count("embedding_batches")
                self.metrics.count("embedding_frames", len(batch))
                self.metrics.set_count("embedding_batch_size_min", min(self.last_batch_sizes))
                self.metrics.set_count("embedding_batch_size_max", max(self.last_batch_sizes))
            start += len(batch)
            if progress_callback:
                progress_callback(min(start, total), total)

        clip_embs = np.concatenate(embeddings, axis=0)
        clip_embs = l2_normalize(clip_embs)

        return clip_embs.astype("float32")


@dataclass
class FrameEmbeddingCache:
    """
    Cache for frame-level embeddings stored in npz format.

    Attributes:
        video_path: Path to the source video
        frame_indices: List of frame indices that were retained
        timestamps: List of timestamps for each frame (in seconds)
        phashes: List of perceptual hash strings
        thumbnail_paths: Legacy list of paths to thumbnail images. New reports
            use timestamps and seek directly in source videos, so this can be empty.
        embeddings: 2D numpy array of shape (N, D) with L2 normalized embeddings
        preprocess_config: Preprocessing configuration used to generate the cache
    """
    video_path: str
    frame_indices: np.ndarray
    timestamps: np.ndarray
    phashes: List[str]
    thumbnail_paths: List[str]
    embeddings: np.ndarray
    preprocess_config: Optional["PreprocessConfig"] = None
    metadata: Optional[Dict[str, object]] = None

    def save(self, path: Union[str, Path]) -> None:
        """
        Save the cache to an npz file.

        Args:
            path: Path to save the npz file
        """
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        config_json = ""
        if self.preprocess_config is not None:
            config_json = json.dumps(self.preprocess_config.to_dict())

        metadata_json = json.dumps(self.metadata or {}, ensure_ascii=False)

        tmp_path = path.with_name(f"{path.name}.tmp")
        try:
            with open(tmp_path, "wb") as f:
                np.savez(
                    f,
                    video_path=np.asarray(self.video_path, dtype=np.str_),
                    frame_indices=self.frame_indices,
                    timestamps=self.timestamps,
                    phashes=np.asarray(self.phashes, dtype=np.str_),
                    thumbnail_paths=np.asarray(self.thumbnail_paths, dtype=np.str_),
                    embeddings=self.embeddings,
                    preprocess_config=np.asarray(config_json, dtype=np.str_),
                    metadata=np.asarray(metadata_json, dtype=np.str_),
                )
            tmp_path.replace(path)
        finally:
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)

        _write_profile_sidecar(path, self.preprocess_config, self.metadata)

    @classmethod
    def load(cls, path: Union[str, Path]) -> "FrameEmbeddingCache":
        """
        Load a cache from an npz file.

        Args:
            path: Path to the npz file

        Returns:
            FrameEmbeddingCache instance

        Raises:
            FileNotFoundError: If the npz file does not exist
        """
        from video_sim.preprocess import PreprocessConfig

        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(f"Cache file not found: {path}")

        try:
            with np.load(str(path), allow_pickle=False) as data:
                # Load preprocess_config if present
                preprocess_config = None
                if "preprocess_config" in data:
                    config_json = _np_scalar_to_string(data["preprocess_config"])
                    if config_json:
                        config_dict = json.loads(config_json)
                        preprocess_config = PreprocessConfig.from_dict(config_dict)

                metadata = None
                if "metadata" in data:
                    metadata_json = _np_scalar_to_string(data["metadata"])
                    if metadata_json:
                        metadata = json.loads(metadata_json)

                return cls(
                    video_path=_np_scalar_to_string(data["video_path"]),
                    frame_indices=np.asarray(data["frame_indices"]),
                    timestamps=np.asarray(data["timestamps"]),
                    phashes=np.asarray(data["phashes"], dtype=np.str_).tolist(),
                    thumbnail_paths=np.asarray(
                        data["thumbnail_paths"], dtype=np.str_
                    ).tolist(),
                    embeddings=np.asarray(data["embeddings"]),
                    preprocess_config=preprocess_config,
                    metadata=metadata,
                )
        except ValueError as error:
            if "Object arrays cannot be loaded" in str(error):
                raise ValueError(
                    "Legacy frame cache contains unsafe pickled object arrays; "
                    "delete or rebuild the cache"
                ) from error
            raise

    @classmethod
    def get_video_cache_dir(
        cls,
        video_path: Union[str, Path],
        cache_dir: Union[str, Path] = "data",
    ) -> Path:
        """Get the per-video cache directory."""
        path = Path(video_path)
        stem = _safe_cache_name(path.stem or "video")
        identity = str(path.resolve(strict=False)).casefold()
        digest = hashlib.sha1(identity.encode("utf-8", errors="ignore")).hexdigest()[:12]
        return Path(cache_dir) / "video_cache" / f"{stem}_{digest}"

    @classmethod
    def get_cache_path(
        cls,
        video_path: Union[str, Path],
        cache_dir: Union[str, Path] = "data",
        preprocess_config: Optional["PreprocessConfig"] = None,
        skip_threshold: Optional[float] = None,
        max_gap_sec: Optional[float] = None,
        frame_step: Optional[int] = None,
    ) -> Path:
        """
        Get the cache file path for a video.

        Args:
            video_path: Path to the video file
            cache_dir: Base cache directory
            preprocess_config: Preprocessing configuration for cache suffix

        Returns:
            Path to the npz cache file
        """
        if preprocess_config is None:
            from video_sim.preprocess import PreprocessConfig
            preprocess_config = PreprocessConfig()

        profile_key = _cache_profile_key(
            preprocess_config,
            skip_threshold,
            max_gap_sec,
            frame_step,
        )
        video_cache_dir = cls.get_video_cache_dir(video_path, cache_dir)
        profile_dir = _find_numbered_profile_dir(video_cache_dir, profile_key)
        if profile_dir is None:
            profile_dir = _next_numbered_profile_dir(video_cache_dir)
        return profile_dir / "frame_features.npz"

    @classmethod
    def get_legacy_cache_path(
        cls,
        video_path: Union[str, Path],
        cache_dir: Union[str, Path] = "data",
        preprocess_config: Optional["PreprocessConfig"] = None,
    ) -> Path:
        """Get the pre-v2 flat cache path for migration diagnostics."""
        if preprocess_config is None:
            from video_sim.preprocess import PreprocessConfig
            preprocess_config = PreprocessConfig()
        return Path(cache_dir) / "embeddings" / f"{Path(video_path).stem}{preprocess_config.cache_suffix}.npz"

    @classmethod
    def build_metadata(
        cls,
        video_path: Union[str, Path],
        skip_threshold: Optional[float],
        max_gap_sec: Optional[float],
        frame_step: Optional[int] = None,
        preprocess_config: Optional["PreprocessConfig"] = None,
        embedding_model: Optional[str] = None,
        embedding_runtime: Optional[str] = None,
    ) -> Dict[str, object]:
        """Build metadata used to decide whether a frame cache is still valid."""
        if preprocess_config is None:
            from video_sim.preprocess import PreprocessConfig
            preprocess_config = PreprocessConfig()

        path = Path(video_path)
        stat = path.stat()
        return {
            "schema_version": FRAME_CACHE_SCHEMA_VERSION,
            "video_path": str(path.resolve(strict=False)),
            "video_size_bytes": int(stat.st_size),
            "video_mtime_ns": int(stat.st_mtime_ns),
            "skip_threshold": _round_optional_float(skip_threshold),
            "max_gap_sec": _round_optional_float(max_gap_sec),
            "frame_step": max(1, int(frame_step or 1)),
            "preprocess_config": preprocess_config.to_dict(),
            "embedding_model": embedding_model or embedding_model_fingerprint(),
            "embedding_runtime": embedding_runtime or embedding_runtime_fingerprint(),
        }

    @classmethod
    def is_metadata_fresh(
        cls,
        actual: Optional[Dict[str, object]],
        expected: Dict[str, object],
    ) -> bool:
        """Return True when cached metadata exactly matches current inputs."""
        if not actual:
            return False
        for key, expected_value in expected.items():
            actual_value = actual.get(key)
            if isinstance(expected_value, float):
                if not _float_equal(actual_value, expected_value):
                    return False
            elif actual_value != expected_value:
                return False
        return True

    @classmethod
    def load_valid(
        cls,
        video_path: Union[str, Path],
        cache_dir: Union[str, Path] = "data",
        preprocess_config: Optional["PreprocessConfig"] = None,
        skip_threshold: Optional[float] = None,
        max_gap_sec: Optional[float] = None,
        frame_step: Optional[int] = None,
        embedding_runtime: Optional[str] = None,
    ) -> Optional["FrameEmbeddingCache"]:
        """Load a cache only when the file and all analysis parameters match."""
        cache_path = cls.get_cache_path(
            video_path,
            cache_dir,
            preprocess_config,
            skip_threshold=skip_threshold,
            max_gap_sec=max_gap_sec,
            frame_step=frame_step,
        )
        if not cache_path.exists():
            cache_path = _find_matching_legacy_profile_cache(
                cache_path, preprocess_config,
                skip_threshold, max_gap_sec, frame_step,
            ) or cache_path
        if not cache_path.exists():
            return None

        try:
            cache = cls.load(cache_path)
        except Exception:
            cache_path.unlink(missing_ok=True)
            return None
        expected = cls.build_metadata(
            video_path,
            skip_threshold=skip_threshold,
            max_gap_sec=max_gap_sec,
            frame_step=frame_step,
            preprocess_config=preprocess_config,
            embedding_runtime=embedding_runtime,
        )
        if cls.is_metadata_fresh(cache.metadata, expected):
            return cache
        return None

    @classmethod
    def exists(
        cls,
        video_path: Union[str, Path],
        cache_dir: Union[str, Path] = "data",
        preprocess_config: Optional["PreprocessConfig"] = None,
        skip_threshold: Optional[float] = None,
        max_gap_sec: Optional[float] = None,
        frame_step: Optional[int] = None,
    ) -> bool:
        """
        Check if a cache file exists for a video.

        Args:
            video_path: Path to the video file
            cache_dir: Base cache directory
            preprocess_config: Preprocessing configuration for cache suffix

        Returns:
            True if cache exists
        """
        return cls.get_cache_path(
            video_path,
            cache_dir,
            preprocess_config,
            skip_threshold=skip_threshold,
            max_gap_sec=max_gap_sec,
            frame_step=frame_step,
        ).exists()


def _embedding_batch_size(device: str, preprocess_config: Optional[PreprocessConfig]) -> int:
    override = os.environ.get("VIDEO_SIM_EMBED_BATCH_SIZE", "").strip()
    if override:
        try:
            return max(1, int(override))
        except ValueError:
            logging.warning("Ignoring invalid VIDEO_SIM_EMBED_BATCH_SIZE=%s", override)

    input_size = getattr(preprocess_config, "input_size", 224) if preprocess_config else 224
    if str(device).lower().startswith("cuda"):
        if input_size >= 512:
            return 2
        if input_size >= 336:
            return 4
        return 8
    if input_size >= 384:
        return 16
    return 32


class _StreamingCancelled(RuntimeError):
    """Internal cancellation signal used to stop a bounded producer queue."""


def _streaming_pipeline_enabled(value: Optional[bool] = None) -> bool:
    """Return whether the bounded streaming path is enabled."""

    return _env_flag("VIDEO_SIM_STREAMING_PIPELINE", True) if value is None else bool(value)


def _retained_frame_pixels(retained_frame, preprocess_config: Optional[PreprocessConfig]) -> np.ndarray:
    """Return one RGB prepared frame, preserving the legacy thumbnail fallback."""

    clip_frame = getattr(retained_frame, "clip_frame", None)
    if clip_frame is not None:
        return np.asarray(clip_frame, dtype=np.uint8)

    thumbnail_path = getattr(retained_frame, "thumbnail_path", "")
    if thumbnail_path:
        from PIL import Image as PILImage

        with PILImage.open(thumbnail_path) as img:
            raw = np.array(img.convert("RGB"), dtype=np.uint8)
        return preprocess_frame_for_clip(raw, preprocess_config)

    raise ValueError(
        f"Retained frame {getattr(retained_frame, 'frame_index', '?')} "
        "has no in-memory frame data or thumbnail path."
    )


def _build_stream_cache(
    *,
    video_path: Path,
    cache_path: Path,
    frame_indices: List[int],
    timestamps: List[float],
    phashes: List[str],
    thumbnail_paths: List[str],
    embedding_chunks: List[np.ndarray],
    preprocess_config: Optional[PreprocessConfig],
    skip_threshold: Optional[float],
    max_gap_sec: Optional[float],
    frame_step: Optional[int],
    source_duration_sec: Optional[float],
    runtime_identity: str,
) -> FrameEmbeddingCache:
    embeddings = np.concatenate(embedding_chunks, axis=0).astype("float32")
    metadata = FrameEmbeddingCache.build_metadata(
        video_path,
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
        preprocess_config=preprocess_config,
        embedding_runtime=runtime_identity,
    )
    retained_duration_sec = max(timestamps, default=0.0)
    duration_sec = max(retained_duration_sec, float(source_duration_sec or 0.0))
    metadata.update(
        {
            "retained_frame_count": len(frame_indices),
            "retained_duration_sec": retained_duration_sec,
            "duration_sec": duration_sec,
        }
    )
    cache = FrameEmbeddingCache(
        video_path=str(video_path),
        frame_indices=np.asarray(frame_indices, dtype=np.int64),
        # Preserve the legacy cache's float64 timestamp representation so
        # streaming and materialized paths are byte-for-byte equivalent.
        timestamps=np.asarray(timestamps, dtype=np.float64),
        phashes=phashes,
        thumbnail_paths=thumbnail_paths,
        embeddings=embeddings,
        preprocess_config=preprocess_config,
        metadata=metadata,
    )
    cache.save(cache_path)
    return cache


def _embed_streaming_from_sampler(
    *,
    video_path: Path,
    sampler,
    embedder: VideoEmbedder,
    cache_path: Path,
    preprocess_config: Optional[PreprocessConfig],
    skip_threshold: Optional[float],
    max_gap_sec: Optional[float],
    frame_step: Optional[int],
    progress_callback: Optional[Callable[[int, int], None]],
    sample_progress_callback: Optional[Callable[[int, int, float], None]],
    runtime_identity: str,
    cancel_event: Optional[threading.Event],
    metrics: Optional[RecognitionMetrics],
    resolved_device: str,
) -> FrameEmbeddingCache:
    """Stream prepared frames into bounded batches and write one cache."""

    batch_size = _embedding_batch_size(resolved_device, preprocess_config)
    frame_indices: List[int] = []
    timestamps: List[float] = []
    phashes: List[str] = []
    thumbnail_paths: List[str] = []
    embedding_chunks: List[np.ndarray] = []
    batch_frames: List[np.ndarray] = []
    total_seen = 0
    released = 0
    streaming_batches = 0
    max_batch_bytes = 0
    callback_embed_elapsed = 0.0

    def flush_batch() -> None:
        nonlocal batch_size, callback_embed_elapsed, released, streaming_batches, max_batch_bytes
        if not batch_frames:
            return
        frame_count = len(batch_frames)
        batch_bytes = sum(int(frame.nbytes) for frame in batch_frames)
        max_batch_bytes = max(max_batch_bytes, batch_bytes)
        frames_array = np.stack(batch_frames, axis=0)
        embed_started = time.perf_counter()
        try:
            embeddings = embedder.embed_frames_batch(
                frames_array,
                batch_size=batch_size,
                progress_callback=None,
                frames_are_preprocessed=True,
            )
            embedding_chunks.append(np.asarray(embeddings, dtype="float32"))
            successful_batches = getattr(embedder, "last_batch_sizes", None) or []
            if successful_batches:
                batch_size = max(1, min(batch_size, min(successful_batches)))
        finally:
            callback_embed_elapsed += time.perf_counter() - embed_started
            del frames_array
            batch_frames.clear()
            released += frame_count
        streaming_batches += 1
        if metrics is not None:
            metrics.count("streaming_batches")
            metrics.count("prepared_frames_released", frame_count)
        if progress_callback:
            # The sampler does not know the final retained count until EOF;
            # report monotonic ``N/N`` updates rather than a false estimate.
            progress_callback(released, max(1, released))

    def consume(retained_frame, pixels: Optional[np.ndarray] = None) -> None:
        nonlocal total_seen
        if cancel_event is not None and cancel_event.is_set():
            raise _StreamingCancelled("streaming embedding cancelled")
        if pixels is None:
            pixels = _retained_frame_pixels(retained_frame, preprocess_config)
        frame_indices.append(int(retained_frame.frame_index))
        timestamps.append(float(retained_frame.timestamp))
        phashes.append(str(retained_frame.phash))
        thumbnail_paths.append(str(getattr(retained_frame, "thumbnail_path", "")))
        batch_frames.append(pixels)
        total_seen += 1
        if metrics is not None:
            metrics.count("frames_sampled")
            metrics.set_count(
                "queue_peak_frames",
                max(metrics.counters.get("queue_peak_frames", 0), len(batch_frames)),
            )
            metrics.set_count("queue_peak_bytes", max(max_batch_bytes, sum(int(f.nbytes) for f in batch_frames)))
        if len(batch_frames) >= batch_size:
            flush_batch()

    use_pipeline = str(resolved_device).lower().startswith("cuda")
    if not use_pipeline:
        sample_started = time.perf_counter()
        try:
            sampler.sample_stream(
                video_path,
                retained_callback=consume,
                progress_callback=sample_progress_callback,
            )
        finally:
            if metrics is not None:
                metrics.record_stage(
                    "decode_sample",
                    max(0.0, time.perf_counter() - sample_started - callback_embed_elapsed),
                    items=total_seen,
                )
    else:
        queue_batch_capacity = max(
            1,
            min(4, int(os.environ.get("VIDEO_SIM_STREAMING_QUEUE_SIZE", "2"))),
        )
        # Queue individual prepared frames, but size it in batch units so the
        # default retains at most two batches behind the GPU consumer.
        capacity = max(batch_size, queue_batch_capacity * batch_size)
        work_queue: queue.Queue = queue.Queue(maxsize=capacity)
        producer_errors: queue.SimpleQueue = queue.SimpleQueue()
        stop_event = threading.Event()
        queue_lock = threading.Lock()
        queued_frames = 0
        queued_bytes = 0
        queue_peak_frames = 0
        queue_peak_bytes = 0

        def enqueue(retained_frame) -> None:
            nonlocal queued_frames, queued_bytes, queue_peak_frames, queue_peak_bytes
            if cancel_event is not None and cancel_event.is_set():
                raise _StreamingCancelled("streaming embedding cancelled")
            pixels = _retained_frame_pixels(retained_frame, preprocess_config)
            item = (retained_frame, pixels)
            while not stop_event.is_set():
                try:
                    work_queue.put(item, timeout=0.05)
                    with queue_lock:
                        queued_frames += 1
                        queued_bytes += int(pixels.nbytes)
                        queue_peak_frames = max(queue_peak_frames, queued_frames)
                        queue_peak_bytes = max(queue_peak_bytes, queued_bytes)
                    return
                except queue.Full:
                    continue
            raise _StreamingCancelled("streaming embedding cancelled")

        def produce() -> None:
            try:
                sample_context = metrics.stage("decode_sample") if metrics is not None else nullcontext()
                with sample_context:
                    sampler.sample_stream(
                        video_path,
                        retained_callback=enqueue,
                        progress_callback=sample_progress_callback,
                    )
            except BaseException as error:
                if not stop_event.is_set() or not isinstance(error, _StreamingCancelled):
                    producer_errors.put(error)
            finally:
                while not stop_event.is_set():
                    try:
                        work_queue.put(None, timeout=0.05)
                        return
                    except queue.Full:
                        continue

        producer = threading.Thread(target=produce, name="video-sim-frame-producer", daemon=False)
        producer.start()
        try:
            while True:
                item = work_queue.get()
                if item is None:
                    break
                retained_frame, pixels = item
                with queue_lock:
                    queued_frames = max(0, queued_frames - 1)
                    queued_bytes = max(0, queued_bytes - int(pixels.nbytes))
                consume(retained_frame, pixels)
            if not producer_errors.empty():
                raise producer_errors.get()
        finally:
            stop_event.set()
            producer.join(timeout=10.0)
            if producer.is_alive():
                raise RuntimeError("streaming frame producer did not stop")
        if metrics is not None:
            metrics.set_count("queue_peak_frames", queue_peak_frames)
            metrics.set_count("queue_peak_bytes", queue_peak_bytes)

    flush_batch()
    if not frame_indices or not embedding_chunks:
        raise ValueError(f"No retained frames available for embedding: {video_path.name}")
    if metrics is not None:
        metrics.set_count("frames_sampled", total_seen)
        metrics.set_count("streaming_batches", streaming_batches)
    return _build_stream_cache(
        video_path=video_path,
        cache_path=cache_path,
        frame_indices=frame_indices,
        timestamps=timestamps,
        phashes=phashes,
        thumbnail_paths=thumbnail_paths,
        embedding_chunks=embedding_chunks,
        preprocess_config=preprocess_config,
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
        source_duration_sec=sampler.source_duration_sec,
        runtime_identity=runtime_identity,
    )


def embed_frames_with_cache(
    video_path: Union[str, Path],
    retained_frames: Optional[Iterable] = None,
    embedder: Optional[VideoEmbedder] = None,
    cache_dir: Union[str, Path] = "data",
    device: Optional[str] = None,
    force: bool = False,
    preprocess_config: Optional[PreprocessConfig] = None,
    skip_threshold: Optional[float] = None,
    max_gap_sec: Optional[float] = None,
    frame_step: Optional[int] = None,
    source_duration_sec: Optional[float] = None,
    progress_callback: Optional[Callable[[int, int], None]] = None,
    embedding_runtime: Optional[str] = None,
    sampler=None,
    streaming: Optional[bool] = None,
    sample_progress_callback: Optional[Callable[[int, int, float], None]] = None,
    cancel_event: Optional[threading.Event] = None,
) -> FrameEmbeddingCache:
    """
    Embed frames with caching support.

    If cache exists and force=False, loads from cache.
    Otherwise, computes embeddings and saves to cache.

    Args:
        video_path: Path to the video file
        retained_frames: Iterable of RetainedFrame objects from DynamicFrameSampler.
            When omitted, ``sampler`` can provide the bounded streaming source.
        embedder: VideoEmbedder instance (created if None)
        cache_dir: Base cache directory
        device: Device to use ('cpu', 'cuda', or 'auto')
        force: Force recomputation even if cache exists
        preprocess_config: Configuration for frame preprocessing (optional)

    Returns:
        FrameEmbeddingCache with embeddings and metadata
    """
    video_path = Path(video_path)
    cache_path = FrameEmbeddingCache.get_cache_path(
        video_path,
        cache_dir,
        preprocess_config,
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
    )

    if device == "auto" or device is None:
        resolved_device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        resolved_device = device
    if embedder is not None and device is None:
        resolved_device = str(getattr(embedder, "device", resolved_device))
    metrics = getattr(embedder, "metrics", None) if embedder is not None else None
    runtime_identity = embedding_runtime
    if runtime_identity is None and embedder is not None:
        runtime_identity = embedder.embedding_runtime_fingerprint()
    runtime_identity = runtime_identity or embedding_runtime_fingerprint(resolved_device)

    # Check cache
    if not force:
        cache = FrameEmbeddingCache.load_valid(
            video_path,
            cache_dir,
            preprocess_config,
            skip_threshold=skip_threshold,
            max_gap_sec=max_gap_sec,
            frame_step=frame_step,
            embedding_runtime=runtime_identity,
        )
        if cache is not None:
            return cache

    # Create embedder if not provided
    if embedder is None:
        embedder = VideoEmbedder(device=resolved_device, preprocess_config=preprocess_config)
        metrics = getattr(embedder, "metrics", None)

    if sampler is not None and retained_frames is None:
        if _streaming_pipeline_enabled(streaming):
            return _embed_streaming_from_sampler(
                video_path=video_path,
                sampler=sampler,
                embedder=embedder,
                cache_path=cache_path,
                preprocess_config=preprocess_config,
                skip_threshold=skip_threshold,
                max_gap_sec=max_gap_sec,
                frame_step=frame_step,
                progress_callback=progress_callback,
                sample_progress_callback=sample_progress_callback,
                runtime_identity=runtime_identity or embedder.embedding_runtime_fingerprint(),
                cancel_event=cancel_event,
                metrics=metrics,
                resolved_device=resolved_device,
            )
        retained_frames = sampler.sample(progress_callback=sample_progress_callback)
        if source_duration_sec is None:
            source_duration_sec = sampler.source_duration_sec

    # Prefer in-memory RGB frames already prepared by DynamicFrameSampler.
    # Older callers may provide thumbnails, so normalize that fallback once
    # before sending a prepared-frame batch to the embedder.
    frames = []
    for rf in retained_frames:
        frames.append(_retained_frame_pixels(rf, preprocess_config))

    if not frames:
        raise ValueError(f"No retained frames available for embedding: {video_path.name}")

    frames_array = np.stack(frames)

    # Compute embeddings
    batch_size = _embedding_batch_size(resolved_device, preprocess_config)
    embeddings = embedder.embed_frames_batch(
        frames_array,
        batch_size=batch_size,
        progress_callback=progress_callback,
        frames_are_preprocessed=True,
    )

    # Create cache
    metadata = FrameEmbeddingCache.build_metadata(
        video_path,
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
        preprocess_config=preprocess_config,
        embedding_runtime=runtime_identity or embedder.embedding_runtime_fingerprint(),
    )
    retained_duration_sec = max((float(rf.timestamp) for rf in retained_frames), default=0.0)
    duration_sec = max(
        retained_duration_sec,
        float(source_duration_sec or 0.0),
    )
    metadata.update(
        {
            "retained_frame_count": len(retained_frames),
            "retained_duration_sec": retained_duration_sec,
            "duration_sec": duration_sec,
        }
    )

    cache = FrameEmbeddingCache(
        video_path=str(video_path),
        frame_indices=np.array([rf.frame_index for rf in retained_frames]),
        timestamps=np.array([rf.timestamp for rf in retained_frames]),
        phashes=[rf.phash for rf in retained_frames],
        thumbnail_paths=[rf.thumbnail_path for rf in retained_frames],
        embeddings=embeddings,
        preprocess_config=preprocess_config,
        metadata=metadata,
    )

    # Save to cache
    cache.save(cache_path)

    return cache


# Module-level embedder instance (lazy initialization)
_embedder: Optional[VideoEmbedder] = None


def get_embedder(device: Optional[str] = None, num_frames: int = 16) -> VideoEmbedder:
    """
    Get or create the global embedder instance.

    Args:
        device: Device to use
        num_frames: Number of frames to use

    Returns:
        VideoEmbedder instance
    """
    global _embedder
    if _embedder is None:
        _embedder = VideoEmbedder(device=device, num_frames=num_frames)
    return _embedder


def embed_video(frames: np.ndarray, num_frames_to_use: int = 16) -> np.ndarray:
    """
    Embed video frames (module-level function for backward compatibility).

    Args:
        frames: numpy array of shape (N, H, W, 3)
        num_frames_to_use: Number of frames to use for embedding

    Returns:
        1D numpy embedding vector (float32)
    """
    embedder = get_embedder(num_frames=num_frames_to_use)
    return embedder.embed(frames)


def _np_scalar_to_string(value) -> str:
    if isinstance(value, np.ndarray) and value.shape == ():
        return str(value.item())
    return str(value)


def _write_profile_sidecar(
    npz_path: Path,
    preprocess_config: Optional["PreprocessConfig"],
    metadata: Optional[Dict[str, object]],
) -> None:
    """Write a human-readable profile.json next to the npz cache file.

    The numbered cache directory stays short; this sidecar keeps the full
    parameter profile readable and lets future runs map the same profile back
    to the same number.
    """
    profile_path = npz_path.parent / "profile.json"
    profile: Dict[str, object] = {}
    if preprocess_config is None and metadata and isinstance(metadata.get("preprocess_config"), dict):
        try:
            preprocess_config = PreprocessConfig.from_dict(metadata["preprocess_config"])
        except Exception:
            preprocess_config = None
    if metadata:
        for key in (
            "skip_threshold",
            "max_gap_sec",
            "frame_step",
            "embedding_model",
            "embedding_runtime",
        ):
            if key in metadata:
                profile[key] = metadata[key]
    if preprocess_config is not None:
        profile["preprocess_config"] = preprocess_config.to_dict()
    profile_key = _profile_key_from_sidecar_data(profile)
    profile.update({
        "version": 1,
        "directory": npz_path.parent.name,
        "cache_file": npz_path.name,
        "profile_key": profile_key,
        "profile_hash": hashlib.sha1(profile_key.encode("utf-8")).hexdigest()[:16],
    })
    try:
        pending = profile_path.with_name(f"{profile_path.name}.tmp")
        with open(pending, "w", encoding="utf-8") as f:
            json.dump(profile, f, ensure_ascii=False, indent=2)
        pending.replace(profile_path)
    except Exception:
        pass


def _cache_profile_key(
    preprocess_config: "PreprocessConfig",
    skip_threshold: Optional[float],
    max_gap_sec: Optional[float],
    frame_step: Optional[int],
) -> str:
    profile_parts = [preprocess_config.cache_suffix.lstrip("_") or "default"]
    if skip_threshold is not None:
        profile_parts.append(f"skip_{_format_cache_float(float(skip_threshold))}")
    if max_gap_sec is not None:
        profile_parts.append(f"gap_{_format_cache_float(float(max_gap_sec))}s")
    if frame_step is not None:
        profile_parts.append(f"step_{max(1, int(frame_step))}")
    return "__".join(profile_parts)


def _profile_key_from_sidecar_data(profile: Dict[str, object]) -> str:
    preprocess_config = profile.get("preprocess_config")
    if isinstance(preprocess_config, dict):
        config = PreprocessConfig.from_dict(preprocess_config)
    else:
        config = PreprocessConfig()
    return _cache_profile_key(
        config,
        _optional_float(profile.get("skip_threshold")),
        _optional_float(profile.get("max_gap_sec")),
        _optional_int(profile.get("frame_step")),
    )


def _read_profile_sidecar(directory: Path) -> Optional[Dict[str, object]]:
    profile_path = directory / "profile.json"
    if not profile_path.is_file():
        return None
    try:
        with open(profile_path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        return loaded if isinstance(loaded, dict) else None
    except Exception:
        return None


def _profile_matches(profile: Optional[Dict[str, object]], expected_key: str) -> bool:
    if not profile:
        return False
    explicit_key = profile.get("profile_key") or profile.get("profileKey")
    if isinstance(explicit_key, str) and explicit_key == expected_key:
        return True
    try:
        return _profile_key_from_sidecar_data(profile) == expected_key
    except Exception:
        return False


def _find_numbered_profile_dir(video_cache_dir: Path, profile_key: str) -> Optional[Path]:
    if not video_cache_dir.is_dir():
        return None
    for directory in _numbered_profile_dirs(video_cache_dir):
        if _profile_matches(_read_profile_sidecar(directory), profile_key):
            return directory
    return None


def _next_numbered_profile_dir(video_cache_dir: Path) -> Path:
    used = {
        int(child.name)
        for child in video_cache_dir.iterdir()
        if child.is_dir() and child.name.isdigit()
    } if video_cache_dir.is_dir() else set()
    index = 1
    while index in used:
        index += 1
    return video_cache_dir / str(index)


def _numbered_profile_dirs(video_cache_dir: Path) -> List[Path]:
    if not video_cache_dir.is_dir():
        return []
    directories = [
        child
        for child in video_cache_dir.iterdir()
        if child.is_dir() and child.name.isdigit()
    ]
    return sorted(directories, key=lambda path: int(path.name))


def _find_matching_legacy_profile_cache(
    new_cache_path: Path,
    preprocess_config: "PreprocessConfig",
    skip_threshold: Optional[float],
    max_gap_sec: Optional[float],
    frame_step: Optional[int],
) -> Optional[Path]:
    """Fall back to older non-numbered profile directories.

    Returns the old-style npz path if found, otherwise None.
    The directory is not renamed because task.json artifacts may still reference it.
    """
    video_cache_dir = new_cache_path.parent.parent
    if not video_cache_dir.is_dir():
        return None
    profile_key = _cache_profile_key(
        preprocess_config,
        skip_threshold,
        max_gap_sec,
        frame_step,
    )
    old_name = _safe_cache_name(profile_key)
    old_path = video_cache_dir / old_name / "frame_features.npz"
    if old_path.exists():
        return old_path
    for directory in video_cache_dir.iterdir():
        if not directory.is_dir() or directory.name.isdigit():
            continue
        candidate = directory / "frame_features.npz"
        if candidate.exists() and _profile_matches(_read_profile_sidecar(directory), profile_key):
            return candidate
    return None


def _safe_cache_name(value: str) -> str:
    cleaned = []
    for char in value:
        if char.isalnum() or char in ("-", "_", "."):
            cleaned.append(char)
        else:
            cleaned.append("_")
    name = "".join(cleaned).strip("._")
    return name or "video"


def _format_cache_float(value: float) -> str:
    return f"{float(value):.4f}".rstrip("0").rstrip(".").replace(".", "p")


def _optional_float(value) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _optional_int(value) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _round_optional_float(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return round(float(value), 6)


def _float_equal(actual, expected: float) -> bool:
    try:
        return abs(float(actual) - expected) <= 1e-6
    except (TypeError, ValueError):
        return False
