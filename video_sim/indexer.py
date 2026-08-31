"""
FAISS index builder module for video similarity search.

Provides indexing functionality for video embeddings using FAISS.
"""

from dataclasses import dataclass
import os
from pathlib import Path
from threading import Lock
from typing import Dict, List, Optional, Union

import faiss
import numpy as np

from video_sim.config import Config
from video_sim.embedder import FrameEmbeddingCache, VideoEmbedder, get_embedder
from video_sim.frame_sampler import FrameSampler, sample_frames


_FAISS_THREAD_LOCK = Lock()
_LAST_FAISS_THREAD_BUDGET: Optional[int] = None


def calculate_faiss_thread_budget(
    compare_workers: int = 1,
    available_cpus: Optional[int] = None,
) -> int:
    """Calculate a per-operation FAISS/OpenMP budget.

    The outer comparison pool owns concurrency.  Dividing available CPUs by
    that worker count prevents ``N`` Python workers from each starting a full
    OpenMP team.  The function is deterministic and handles restricted or
    unavailable CPU information for tests and packaged runtimes.
    """
    workers = max(1, int(compare_workers or 1))
    detected = os.cpu_count() if available_cpus is None else available_cpus
    cpus = max(1, int(detected or 1))
    return max(1, cpus // workers)


def configure_faiss_thread_budget(
    compare_workers: int = 1,
    available_cpus: Optional[int] = None,
) -> int:
    """Set FAISS's OpenMP budget for the current calling thread.

    FAISS versions without ``omp_set_num_threads`` are supported.  A small
    lock serializes the setter because some FAISS builds expose shared
    runtime state.  The last-value field is retained for diagnostics and
    backwards-compatible test hooks, but deliberately does not suppress a
    repeated call: FAISS's OpenMP setting can be thread-local.  Call this from
    a worker-pool initializer (or once per coordinating operation), never from
    an individual query loop.
    """
    global _LAST_FAISS_THREAD_BUDGET
    budget = calculate_faiss_thread_budget(compare_workers, available_cpus)
    with _FAISS_THREAD_LOCK:
        setter = getattr(faiss, "omp_set_num_threads", None)
        if callable(setter):
            setter(int(budget))
            _LAST_FAISS_THREAD_BUDGET = budget
    return budget


class VideoIndexer:
    """
    FAISS index builder for video embeddings.

    Handles building, saving, and loading FAISS indices.
    """

    def __init__(
        self,
        index_path: Optional[Union[str, Path]] = None,
        meta_path: Optional[Union[str, Path]] = None,
        use_legacy_paths: bool = False,
    ):
        """
        Initialize the video indexer.

        Args:
            index_path: Path to save/load the FAISS index
            meta_path: Path to save/load the metadata file
            use_legacy_paths: Whether to use legacy paths (project root)
        """
        if use_legacy_paths:
            self.index_path = Path(index_path) if index_path else Config.get_legacy_index_path()
            self.meta_path = Path(meta_path) if meta_path else Config.get_legacy_meta_path()
        else:
            self.index_path = Path(index_path) if index_path else Config.get_index_path()
            self.meta_path = Path(meta_path) if meta_path else Config.get_meta_path()

        self.index: Optional[faiss.Index] = None
        self.meta: List[str] = []

    def build_from_videos(
        self,
        videos_dir: Union[str, Path],
        embeddings_dir: Optional[Union[str, Path]] = None,
        embedder: Optional[VideoEmbedder] = None,
        save_embeddings: bool = True,
    ) -> None:
        """
        Build FAISS index from video files.

        Args:
            videos_dir: Directory containing video files
            embeddings_dir: Directory to save individual embeddings
            embedder: VideoEmbedder instance (created if None)
            save_embeddings: Whether to save individual embeddings
        """
        videos_dir = Path(videos_dir)

        if embeddings_dir is None:
            embeddings_dir = Config.EMBEDDINGS_DIR
        embeddings_dir = Path(embeddings_dir)
        embeddings_dir.mkdir(parents=True, exist_ok=True)

        if embedder is None:
            embedder = get_embedder()

        # Find video files
        video_files = [
            f
            for f in videos_dir.iterdir()
            if f.suffix.lower() in Config.VIDEO_EXTENSIONS
        ]
        video_files = sorted(video_files)

        if not video_files:
            print(f"No video files found in {videos_dir}")
            return

        embeddings = []
        meta = []

        for i, vf in enumerate(video_files):
            print(f"[{i + 1}/{len(video_files)}] Processing {vf.name}...")
            frames = sample_frames(str(vf))
            emb = embedder.embed(frames)
            embeddings.append(emb)
            meta.append(vf.name)

            if save_embeddings:
                np.save(embeddings_dir / f"{vf.name}.npy", emb)

        # Build FAISS index
        embeddings_array = np.array(embeddings).astype("float32")
        d = embeddings_array.shape[1]

        # Use IndexFlatIP for cosine similarity (vectors should be normalized)
        self.index = faiss.IndexFlatIP(d)
        faiss.normalize_L2(embeddings_array)
        self.index.add(embeddings_array)

        self.meta = meta

        # Save index and metadata
        self.save()

        print(f"Built FAISS index with {len(video_files)} videos.")

    def build_from_embeddings(
        self,
        embeddings: np.ndarray,
        meta: List[str],
    ) -> None:
        """
        Build FAISS index from pre-computed embeddings.

        Args:
            embeddings: numpy array of shape (N, dim)
            meta: List of video identifiers
        """
        embeddings = embeddings.astype("float32")
        d = embeddings.shape[1]

        self.index = faiss.IndexFlatIP(d)
        faiss.normalize_L2(embeddings)
        self.index.add(embeddings)

        self.meta = meta

    def save(
        self,
        index_path: Optional[Union[str, Path]] = None,
        meta_path: Optional[Union[str, Path]] = None,
    ) -> None:
        """
        Save the index and metadata to disk.

        Args:
            index_path: Path to save the index (uses default if None)
            meta_path: Path to save the metadata (uses default if None)
        """
        if self.index is None:
            raise ValueError("No index to save. Build or load an index first.")

        idx_path = Path(index_path) if index_path else self.index_path
        mt_path = Path(meta_path) if meta_path else self.meta_path

        # Ensure parent directories exist
        idx_path.parent.mkdir(parents=True, exist_ok=True)
        mt_path.parent.mkdir(parents=True, exist_ok=True)

        faiss.write_index(self.index, str(idx_path))

        with open(mt_path, "w", encoding="utf-8") as f:
            for m in self.meta:
                f.write(m + "\n")

        print(f"Saved index to {idx_path}")
        print(f"Saved metadata to {mt_path}")

    def load(
        self,
        index_path: Optional[Union[str, Path]] = None,
        meta_path: Optional[Union[str, Path]] = None,
    ) -> None:
        """
        Load the index and metadata from disk.

        Args:
            index_path: Path to the index file
            meta_path: Path to the metadata file
        """
        idx_path = Path(index_path) if index_path else self.index_path
        mt_path = Path(meta_path) if meta_path else self.meta_path

        self.index = faiss.read_index(str(idx_path))

        with open(mt_path, "r", encoding="utf-8") as f:
            self.meta = [line.strip() for line in f.readlines()]

        print(f"Loaded index with {self.index.ntotal} vectors from {idx_path}")

    @property
    def num_vectors(self) -> int:
        """Get the number of vectors in the index."""
        return self.index.ntotal if self.index else 0


def build_index(
    videos_dir: Union[str, Path] = "videos",
    embeddings_dir: Union[str, Path] = "embeddings",
    index_file: Union[str, Path] = "faiss_video_index.bin",
    meta_file: Union[str, Path] = "video_meta.txt",
) -> None:
    """
    Build FAISS index from videos (module-level function for backward compatibility).

    Args:
        videos_dir: Directory containing video files
        embeddings_dir: Directory to save embeddings
        index_file: Path to save the index
        meta_file: Path to save the metadata
    """
    indexer = VideoIndexer(index_path=index_file, meta_path=meta_file)
    indexer.build_from_videos(videos_dir, embeddings_dir)


@dataclass
class FrameIndexResult:
    """
    Result of building a FAISS index from frame embeddings.

    Attributes:
        index: FAISS IndexFlatIP built from frame embeddings
        video_path: Path to the source video
        frame_indices: Array of frame indices (for mapping back to original frames)
        timestamps: Array of timestamps in seconds
        thumbnail_paths: List of preprocessed frame thumbnail paths
        num_frames: Number of frames in the index
    """

    index: faiss.Index
    video_path: str
    frame_indices: np.ndarray
    timestamps: np.ndarray
    thumbnail_paths: List[str]

    @property
    def num_frames(self) -> int:
        """Get the number of frames in the index."""
        return self.index.ntotal


def build_frame_index(
    cache: FrameEmbeddingCache,
) -> FrameIndexResult:
    """
    Build a FAISS IndexFlatIP from frame-level embeddings.

    Args:
        cache: FrameEmbeddingCache containing frame embeddings and metadata

    Returns:
        FrameIndexResult with FAISS index and metadata
    """
    raw_embeddings = np.asarray(cache.embeddings)
    embeddings_reusable = (
        raw_embeddings.dtype == np.dtype("float32")
        and raw_embeddings.ndim == 2
        and raw_embeddings.flags.c_contiguous
        and _is_l2_normalized(raw_embeddings)
    )
    if embeddings_reusable:
        # FAISS copies vectors into its own index.  Avoid making a second
        # Python-side matrix when the cache already satisfies the contract.
        embeddings = raw_embeddings
    else:
        # Legacy/non-normalized caches need an isolated float32 buffer because
        # normalization is in-place and must not mutate the loaded cache.
        embeddings = np.array(raw_embeddings, dtype="float32", order="C", copy=True)
    d = embeddings.shape[1]

    # Use IndexFlatIP for inner product (cosine similarity when normalized)
    index = faiss.IndexFlatIP(d)

    # Normalize only the legacy/non-normalized path; the reusable path is
    # already L2-normalized by the embedder contract.
    if not embeddings_reusable:
        faiss.normalize_L2(embeddings)
    index.add(embeddings)

    return FrameIndexResult(
        index=index,
        video_path=cache.video_path,
        frame_indices=cache.frame_indices.copy(),
        timestamps=cache.timestamps.copy(),
        thumbnail_paths=list(cache.thumbnail_paths),
    )


def _is_l2_normalized(embeddings: np.ndarray, tolerance: float = 1e-3) -> bool:
    """Return whether a float32 matrix already satisfies the cosine contract."""
    if embeddings.ndim != 2 or len(embeddings) == 0:
        return embeddings.ndim == 2
    if not np.isfinite(embeddings).all():
        return False
    squared_norms = np.einsum("ij,ij->i", embeddings, embeddings)
    return bool(np.all(np.abs(squared_norms - 1.0) <= float(tolerance)))


def build_frame_index_from_path(
    npz_path: Union[str, Path],
) -> FrameIndexResult:
    """
    Build a FAISS IndexFlatIP from a frame embedding cache file.

    Args:
        npz_path: Path to the npz cache file

    Returns:
        FrameIndexResult with FAISS index and metadata
    """
    cache = FrameEmbeddingCache.load(npz_path)
    return build_frame_index(cache)
