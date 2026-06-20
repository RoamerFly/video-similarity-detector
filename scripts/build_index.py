"""
FAISS index builder - Backward compatible wrapper.

This module imports from video_sim.indexer for backward compatibility.
New code should import directly from video_sim.indexer.
"""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from video_sim.indexer import VideoIndexer, build_index
from video_sim.embedder import get_embedder
from video_sim.frame_sampler import sample_frames

# Re-export for backward compatibility
__all__ = ["VideoIndexer", "build_index"]

# Legacy constants for backward compatibility
VIDEOS_DIR = "videos"
EMBEDDINGS_DIR = "embeddings"
INDEX_FILE = "faiss_video_index.bin"
META_FILE = "video_meta.txt"


def main():
    """Main function matching original script behavior."""
    import os

    os.makedirs(EMBEDDINGS_DIR, exist_ok=True)

    # Use the VideoIndexer with legacy paths
    indexer = VideoIndexer(use_legacy_paths=True)
    embedder = get_embedder()

    indexer.build_from_videos(
        videos_dir=VIDEOS_DIR,
        embeddings_dir=EMBEDDINGS_DIR,
        embedder=embedder,
        save_embeddings=True,
    )


if __name__ == "__main__":
    main()
