"""
Query index module - Backward compatible wrapper.

This module imports from video_sim.matcher for backward compatibility.
New code should import directly from video_sim.matcher.
"""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from video_sim.matcher import VideoMatcher, query, load_index

# Re-export for backward compatibility
__all__ = ["VideoMatcher", "query", "load_index"]

# Legacy constants for backward compatibility
INDEX_FILE = "faiss_video_index.bin"
META_FILE = "video_meta.txt"


def main():
    """Main function matching original script behavior."""
    if len(sys.argv) < 2:
        print("Usage: python query_index.py <video_path>")
        sys.exit(1)

    video_path = sys.argv[1]
    results = query(video_path, top_k=5, index_file=INDEX_FILE, meta_file=META_FILE)

    print("Top similar videos:")
    for filename, score in results:
        print(f"{filename} | similarity: {score:.4f}")


if __name__ == "__main__":
    main()
