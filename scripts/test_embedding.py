"""
Test embedding module - Backward compatible wrapper.

This module imports from video_sim for backward compatibility.
"""

import sys
import os
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

import numpy as np
from video_sim.embedder import embed_video
from video_sim.frame_sampler import sample_frames


def test_embedding():
    """Test video embedding functionality."""
    video_path = "../videos/HP.mp4"
    if not os.path.exists(video_path):
        # Try to find any video
        video_dir = Path(__file__).parent.parent / "videos"
        videos = list(video_dir.glob("*.mp4"))
        if videos:
            video_path = str(videos[0])
        else:
            print("No videos found.")
            return

    print(f"Testing embedding with video: {video_path}")

    # Sample frames (using our adaptive sampling)
    frames = sample_frames(video_path, num_frames=16, adaptive=True)
    print(f"Sampled frames shape: {frames.shape}")

    # Embed video
    try:
        emb = embed_video(frames)

        # Validate embedding
        dim = emb.shape[0]
        norm = np.linalg.norm(emb)

        print(f"Embedding shape: {emb.shape}")
        print(f"Embedding dim: {dim}")
        print(f"Embedding norm: {norm:.6f}")

        # Check: must be 1-D vector
        if emb.ndim != 1:
            print(f"FAILURE: Expected 1-D vector, got ndim={emb.ndim}")
            return

        # Check: must have positive dimension
        if dim <= 0:
            print(f"FAILURE: Invalid dimension {dim}")
            return

        # Check: norm should be close to 1.0 (normalized)
        norm_tolerance = 0.1
        if abs(norm - 1.0) > norm_tolerance:
            print(f"WARNING: Norm {norm:.4f} deviates from 1.0 (tolerance={norm_tolerance})")

        print(f"SUCCESS: Embedding is valid ({dim}-dim, norm={norm:.4f})")

    except Exception as e:
        print(f"FAILURE: Error during embedding: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    test_embedding()
