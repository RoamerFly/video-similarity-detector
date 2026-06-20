"""
Frame extraction module - Backward compatible wrapper.

This module imports from video_sim.frame_sampler for backward compatibility.
New code should import directly from video_sim.frame_sampler.
"""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from video_sim.frame_sampler import (
    compute_frame_features,
    sample_frames,
    FrameSampler,
)

# Re-export for backward compatibility
__all__ = ["compute_frame_features", "sample_frames", "FrameSampler"]

if __name__ == "__main__":
    # Simple test when run directly
    import numpy as np

    video_dir = Path(__file__).parent.parent / "videos"
    videos = list(video_dir.glob("*.mp4"))

    if videos:
        video_path = str(videos[0])
        print(f"Testing frame extraction with: {video_path}")

        frames = sample_frames(video_path, num_frames=16, adaptive=True)
        print(f"Extracted frames shape: {frames.shape}")

        features = compute_frame_features(frames)
        print(f"Features shape: {features.shape}")
    else:
        print("No videos found in videos/ directory")
