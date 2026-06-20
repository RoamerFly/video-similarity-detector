"""
FAISS index builder module for video similarity search.

Provides indexing functionality for video embeddings using FAISS.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Union

import faiss
import numpy as np

from video_sim.config import Config
from video_sim.embedder import FrameEmbeddingCache, VideoEmbedder, get_embedder
from video_sim.frame_sampler import FrameSampler, sample_frames


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
    embeddings = cache.embeddings.astype("float32")
    d = embeddings.shape[1]

    # Use IndexFlatIP for inner product (cosine similarity when normalized)
    index = faiss.IndexFlatIP(d)

    # Normalize embeddings for cosine similarity
    faiss.normalize_L2(embeddings)
    index.add(embeddings)

    return FrameIndexResult(
        index=index,
        video_path=cache.video_path,
        frame_indices=cache.frame_indices.copy(),
        timestamps=cache.timestamps.copy(),
        thumbnail_paths=list(cache.thumbnail_paths),
    )


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
