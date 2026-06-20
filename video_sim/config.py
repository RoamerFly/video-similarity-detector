"""
Configuration module for video_sim.

Provides path configuration and common settings using pathlib for cross-platform support.
"""

from pathlib import Path
from typing import Optional


class Config:
    """Configuration class for video similarity search."""

    # Base directory (project root)
    PROJECT_ROOT: Path = Path(__file__).parent.parent

    # Data directories
    DATA_DIR: Path = PROJECT_ROOT / "data"
    FRAMES_DIR: Path = DATA_DIR / "frames"
    EMBEDDINGS_DIR: Path = DATA_DIR / "embeddings"
    INDEXES_DIR: Path = DATA_DIR / "indexes"
    REPORTS_DIR: Path = DATA_DIR / "reports"

    # Legacy directories (for backward compatibility)
    VIDEOS_DIR: Path = PROJECT_ROOT / "videos"
    LEGACY_EMBEDDINGS_DIR: Path = PROJECT_ROOT / "embeddings"

    # Index files
    DEFAULT_INDEX_NAME: str = "faiss_video_index"
    DEFAULT_META_NAME: str = "video_meta"

    # Model settings
    DEFAULT_NUM_FRAMES: int = 16
    ADAPTIVE_SAMPLING: bool = True
    OVERSAMPLE_FACTOR: int = 4

    # Supported video extensions
    VIDEO_EXTENSIONS: tuple = (".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv")

    @classmethod
    def ensure_dirs(cls) -> None:
        """Create all data directories if they don't exist."""
        cls.FRAMES_DIR.mkdir(parents=True, exist_ok=True)
        cls.EMBEDDINGS_DIR.mkdir(parents=True, exist_ok=True)
        cls.INDEXES_DIR.mkdir(parents=True, exist_ok=True)
        cls.REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    @classmethod
    def get_index_path(cls, index_name: Optional[str] = None) -> Path:
        """Get the path to the FAISS index file."""
        name = index_name or cls.DEFAULT_INDEX_NAME
        return cls.INDEXES_DIR / f"{name}.bin"

    @classmethod
    def get_meta_path(cls, meta_name: Optional[str] = None) -> Path:
        """Get the path to the metadata file."""
        name = meta_name or cls.DEFAULT_META_NAME
        return cls.INDEXES_DIR / f"{name}.txt"

    @classmethod
    def get_legacy_index_path(cls) -> Path:
        """Get the legacy index path (project root)."""
        return cls.PROJECT_ROOT / "faiss_video_index.bin"

    @classmethod
    def get_legacy_meta_path(cls) -> Path:
        """Get the legacy meta path (project root)."""
        return cls.PROJECT_ROOT / "video_meta.txt"
