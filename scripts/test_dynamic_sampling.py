"""
Test dynamic frame sampling based on perceptual hashing.

Usage:
    python scripts/test_dynamic_sampling.py --video videos/HP.mp4 --cache-dir data --skip-threshold 0.90
"""

import argparse
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from video_sim.frame_sampler import DynamicFrameSampler


def main():
    parser = argparse.ArgumentParser(
        description="Test dynamic frame sampling with perceptual hashing"
    )
    parser.add_argument(
        "--video",
        type=str,
        required=True,
        help="Path to video file",
    )
    parser.add_argument(
        "--cache-dir",
        type=str,
        default="data",
        help="Base directory for caching frames (default: data)",
    )
    parser.add_argument(
        "--skip-threshold",
        type=float,
        default=0.90,
        help="Similarity threshold for skipping frames (default: 0.90)",
    )
    parser.add_argument(
        "--max-gap-sec",
        type=float,
        default=5.0,
        help="Maximum seconds between retained frames (default: 5.0)",
    )

    args = parser.parse_args()

    # Validate video path
    video_path = Path(args.video)
    if not video_path.exists():
        print(f"ERROR: Video not found: {video_path}")
        sys.exit(1)

    # Initialize sampler
    sampler = DynamicFrameSampler(
        skip_threshold=args.skip_threshold,
        max_gap_sec=args.max_gap_sec,
        cache_dir=args.cache_dir,
    )

    print(f"Video: {video_path}")
    print(f"Cache dir: {args.cache_dir}")
    print(f"Skip threshold: {args.skip_threshold}")
    print(f"Max gap: {args.max_gap_sec} sec")
    print()

    # Run dynamic sampling
    print("Running dynamic frame sampling...")
    retained_frames = sampler.sample(video_path)

    # Get video info using OpenCV
    import cv2
    cap = cv2.VideoCapture(str(video_path))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    duration = total_frames / fps if fps > 0 else 0
    cap.release()

    # Compute statistics
    retained_count = len(retained_frames)
    retain_ratio = retained_count / total_frames if total_frames > 0 else 0

    # Get thumbnail directory
    thumbnail_dir = Path(args.cache_dir) / "frames" / video_path.stem

    # Print results
    print()
    print("=" * 60)
    print("Results:")
    print("=" * 60)
    print(f"Video total frames: {total_frames}")
    print(f"Video duration: {duration:.2f} sec")
    print(f"Video FPS: {fps:.2f}")
    print(f"Retained frames: {retained_count}")
    print(f"Retain ratio: {retain_ratio:.2%}")
    print(f"Thumbnail directory: {thumbnail_dir}")
    print()

    if retained_frames:
        print("Retained frames:")
        print("-" * 60)
        for i, rf in enumerate(retained_frames):
            print(
                f"  [{i+1}] frame_index={rf.frame_index}, "
                f"timestamp={rf.timestamp:.2f}s, "
                f"phash={rf.phash}"
            )

    print()
    print("SUCCESS: Dynamic sampling completed.")


if __name__ == "__main__":
    main()
