"""
Video embedding module - Backward compatible wrapper.

This module imports from video_sim.embedder for backward compatibility.
New code should import directly from video_sim.embedder.
"""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from video_sim.embedder import (
    VideoEmbedder,
    embed_video,
    frames_to_pil,
    get_embedder,
)

# Re-export for backward compatibility
__all__ = ["VideoEmbedder", "embed_video", "frames_to_pil", "get_embedder"]

if __name__ == "__main__":
    # Simple test when run directly
    import numpy as np
    from video_sim.frame_sampler import sample_frames

    video_dir = Path(__file__).parent.parent / "videos"
    videos = list(video_dir.glob("*.mp4"))

    if videos:
        video_path = str(videos[0])
        print(f"Testing embedding with: {video_path}")

        frames = sample_frames(video_path, num_frames=16)
        emb = embed_video(frames)
        print(f"Embedding shape: {emb.shape}")
        print(f"Embedding norm: {np.linalg.norm(emb):.4f}")
    else:
        print("No videos found in videos/ directory")
