"""
Video embedding module for video similarity search.

Provides video embedding using CLIP model for image representation.

Supports both:
- Video-level embedding (average of frame embeddings)
- Frame-level embedding (one embedding per frame)
"""

from contextlib import redirect_stderr
from dataclasses import dataclass
import hashlib
import io
import json
import logging
import os
from pathlib import Path
from typing import Callable, Dict, List, Optional, Union
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
from video_sim.model_locator import (
    DEFAULT_EMBEDDING_MODEL,
    resolve_embedding_model_source,
)

FRAME_CACHE_SCHEMA_VERSION = 2


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
        self._load_models()

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
            f"Loading CLIP model on {self.device} from "
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
        frames = frames.astype("uint8")

        if len(frames) == 0:
            raise ValueError(
                "No frames provided to embed. Video might be empty or unreadable."
            )

        # Preprocess each frame for CLIP
        processed_frames = [
            preprocess_frame_for_clip(frame, self.preprocess_config)
            for frame in frames
        ]
        pil_frames = [Image.fromarray(f) for f in processed_frames]

        # Sample frames if we have more than needed
        if len(pil_frames) > self.num_frames:
            indices = np.linspace(0, len(pil_frames) - 1, self.num_frames).astype(int)
            pil_frames = [pil_frames[i] for i in indices]
        elif len(pil_frames) < self.num_frames:
            # Pad by duplicating the last frame
            while len(pil_frames) < self.num_frames:
                pil_frames.append(pil_frames[-1])

        with torch.no_grad():
            # CLIP Embedding
            clip_inputs = self.clip_processor(images=pil_frames, return_tensors="pt").to(
                self.device
            )
            clip_outputs = self.clip_model(**clip_inputs)
            clip_emb = clip_outputs.pooler_output.mean(dim=0).cpu().numpy()

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
        frame = frame.astype("uint8")

        # Preprocess frame for CLIP
        processed = preprocess_frame_for_clip(frame, self.preprocess_config)
        pil_frame = Image.fromarray(processed)

        with torch.no_grad():
            # CLIP Embedding for single frame
            clip_inputs = self.clip_processor(images=[pil_frame], return_tensors="pt").to(
                self.device
            )
            clip_outputs = self.clip_model(**clip_inputs)
            clip_emb = clip_outputs.pooler_output[0].cpu().numpy()

        # L2 normalize
        clip_emb = l2_normalize(clip_emb)

        return clip_emb.astype("float32")

    def embed_frames_batch(
        self,
        frames: np.ndarray,
        batch_size: int = 32,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> np.ndarray:
        """
        Embed multiple frames, returning one embedding per frame.

        Unlike embed(), this does not average frame embeddings.
        Each frame gets its own independent embedding.

        Args:
            frames: numpy array of shape (N, H, W, 3) dtype uint8

        Returns:
            2D numpy array of shape (N, 512) with dtype float32, L2 normalized
        """
        frames = frames.astype("uint8")

        if len(frames) == 0:
            return np.zeros((0, 512), dtype="float32")

        batch_size = max(1, int(batch_size))
        embeddings = []
        total = len(frames)

        for start in range(0, total, batch_size):
            batch = frames[start:start + batch_size]
            processed_frames = [
                preprocess_frame_for_clip(frame, self.preprocess_config)
                for frame in batch
            ]
            pil_frames = [Image.fromarray(f) for f in processed_frames]

            with torch.no_grad():
                clip_inputs = self.clip_processor(images=pil_frames, return_tensors="pt").to(
                    self.device
                )
                clip_outputs = self.clip_model(**clip_inputs)
                batch_embs = clip_outputs.pooler_output.cpu().numpy()

            embeddings.append(batch_embs)
            if str(self.device).startswith("cuda"):
                torch.cuda.empty_cache()
            if progress_callback:
                progress_callback(min(start + len(batch), total), total)

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
                    video_path=self.video_path,
                    frame_indices=self.frame_indices,
                    timestamps=self.timestamps,
                    phashes=np.array(self.phashes, dtype=object),
                    thumbnail_paths=np.array(self.thumbnail_paths, dtype=object),
                    embeddings=self.embeddings,
                    preprocess_config=np.array(config_json, dtype=object),
                    metadata=np.array(metadata_json, dtype=object),
                )
            tmp_path.replace(path)
        finally:
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)

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

        data = np.load(str(path), allow_pickle=True)

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
            frame_indices=data["frame_indices"],
            timestamps=data["timestamps"],
            phashes=data["phashes"].tolist() if hasattr(data["phashes"], "tolist") else list(data["phashes"]),
            thumbnail_paths=data["thumbnail_paths"].tolist() if hasattr(data["thumbnail_paths"], "tolist") else list(data["thumbnail_paths"]),
            embeddings=data["embeddings"],
            preprocess_config=preprocess_config,
            metadata=metadata,
        )

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

        profile_parts = [preprocess_config.cache_suffix.lstrip("_") or "default"]
        if skip_threshold is not None:
            profile_parts.append(f"skip_{_format_cache_float(skip_threshold)}")
        if max_gap_sec is not None:
            profile_parts.append(f"gap_{_format_cache_float(max_gap_sec)}s")
        if frame_step is not None:
            profile_parts.append(f"step_{max(1, int(frame_step))}")

        profile_dir = _safe_cache_name("__".join(profile_parts))
        return cls.get_video_cache_dir(video_path, cache_dir) / profile_dir / "frame_features.npz"

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
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
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
            "embedding_model": embedding_model,
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


def embed_frames_with_cache(
    video_path: Union[str, Path],
    retained_frames: List,
    embedder: Optional[VideoEmbedder] = None,
    cache_dir: Union[str, Path] = "data",
    device: Optional[str] = None,
    force: bool = False,
    preprocess_config: Optional[PreprocessConfig] = None,
    skip_threshold: Optional[float] = None,
    max_gap_sec: Optional[float] = None,
    frame_step: Optional[int] = None,
    progress_callback: Optional[Callable[[int, int], None]] = None,
) -> FrameEmbeddingCache:
    """
    Embed frames with caching support.

    If cache exists and force=False, loads from cache.
    Otherwise, computes embeddings and saves to cache.

    Args:
        video_path: Path to the video file
        retained_frames: List of RetainedFrame objects from DynamicFrameSampler
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

    # Check cache
    if not force:
        cache = FrameEmbeddingCache.load_valid(
            video_path,
            cache_dir,
            preprocess_config,
            skip_threshold=skip_threshold,
            max_gap_sec=max_gap_sec,
            frame_step=frame_step,
        )
        if cache is not None:
            return cache

    # Resolve device
    if device == "auto" or device is None:
        resolved_device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        resolved_device = device

    # Create embedder if not provided
    if embedder is None:
        embedder = VideoEmbedder(device=resolved_device, preprocess_config=preprocess_config)

    # Prefer in-memory preprocessed frames from DynamicFrameSampler. Older caches
    # may still provide thumbnail_path, so keep that path as a fallback.
    frames = []
    for rf in retained_frames:
        clip_frame = getattr(rf, "clip_frame", None)
        if clip_frame is not None:
            frames.append(np.asarray(clip_frame, dtype=np.uint8))
            continue

        thumbnail_path = getattr(rf, "thumbnail_path", "")
        if thumbnail_path:
            from PIL import Image as PILImage
            img = PILImage.open(thumbnail_path)
            frames.append(np.array(img, dtype=np.uint8))
            continue

        raise ValueError(
            f"Retained frame {getattr(rf, 'frame_index', '?')} from {video_path.name} "
            "has no in-memory frame data or thumbnail path."
        )

    if not frames:
        raise ValueError(f"No retained frames available for embedding: {video_path.name}")

    frames_array = np.stack(frames)

    # Compute embeddings
    batch_size = _embedding_batch_size(resolved_device, preprocess_config)
    embeddings = embedder.embed_frames_batch(
        frames_array,
        batch_size=batch_size,
        progress_callback=progress_callback,
    )

    # Create cache
    metadata = FrameEmbeddingCache.build_metadata(
        video_path,
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
        preprocess_config=preprocess_config,
    )
    retained_duration_sec = max((float(rf.timestamp) for rf in retained_frames), default=0.0)
    metadata.update(
        {
            "retained_frame_count": len(retained_frames),
            "retained_duration_sec": retained_duration_sec,
            "duration_sec": retained_duration_sec,
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


def _round_optional_float(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return round(float(value), 6)


def _float_equal(actual, expected: float) -> bool:
    try:
        return abs(float(actual) - expected) <= 1e-6
    except (TypeError, ValueError):
        return False
