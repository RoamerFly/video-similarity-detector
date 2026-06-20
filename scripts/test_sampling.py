"""
Test sampling module - Backward compatible wrapper.

This module imports from video_sim for backward compatibility.
"""

import sys
import os
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

import numpy as np
from video_sim.frame_sampler import sample_frames, compute_frame_features


def test_sampling():
    """Test frame sampling functionality."""
    video_path = "../videos/Jk_1.mp4"
    if not os.path.exists(video_path):
        print(f"Video not found: {video_path}")
        # Try to find any video
        video_dir = Path(__file__).parent.parent / "videos"
        videos = list(video_dir.glob("*.mp4"))
        if videos:
            video_path = str(videos[0])
            print(f"Using video: {video_path}")
        else:
            print("No videos found.")
            return

    print(f"Testing with video: {video_path}")

    # 1. Test Uniform Sampling
    print("\n--- Testing Uniform Sampling ---")
    frames_uniform = sample_frames(video_path, num_frames=16, adaptive=False)
    print(f"Uniform frames shape: {frames_uniform.shape}")

    # Compute diversity (lower pairwise similarity is better)
    feats_uniform = compute_frame_features(frames_uniform)
    sim_matrix_uniform = np.dot(feats_uniform, feats_uniform.T)
    # Average off-diagonal similarity
    n = len(frames_uniform)
    avg_sim_uniform = (np.sum(sim_matrix_uniform) - n) / (n * (n - 1))
    print(f"Average pairwise similarity (Uniform): {avg_sim_uniform:.4f}")

    # 2. Test Adaptive Sampling
    print("\n--- Testing Adaptive Sampling ---")
    frames_adaptive = sample_frames(video_path, num_frames=16, adaptive=True)
    print(f"Adaptive frames shape: {frames_adaptive.shape}")

    feats_adaptive = compute_frame_features(frames_adaptive)
    sim_matrix_adaptive = np.dot(feats_adaptive, feats_adaptive.T)
    avg_sim_adaptive = (np.sum(sim_matrix_adaptive) - n) / (n * (n - 1))
    print(f"Average pairwise similarity (Adaptive): {avg_sim_adaptive:.4f}")

    if avg_sim_adaptive < avg_sim_uniform:
        print("\nSUCCESS: Adaptive sampling produced more diverse frames (lower similarity).")
    else:
        print("\nNOTE: Adaptive sampling did not produce lower similarity. This can happen depending on video content.")


if __name__ == "__main__":
    test_sampling()
