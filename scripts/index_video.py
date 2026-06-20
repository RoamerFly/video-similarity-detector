#!/usr/bin/env python3
"""
Index video script - Extract frame-level embeddings and save to npz cache.

Usage:
    python scripts/index_video.py --video videos/HP.mp4 --cache-dir data --skip-threshold 0.90 --device auto

Execution flow:
    1. Dynamic frame sampling (using pHash similarity)
    2. Extract frame-level embeddings (CLIP + VideoMAE)
    3. Save to npz cache
    4. Print frame count and embedding shape
"""

import argparse
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from video_sim.frame_sampler import DynamicFrameSampler
from video_sim.embedder import VideoEmbedder, embed_frames_with_cache, FrameEmbeddingCache
from video_sim.preprocess import PreprocessConfig, add_preprocess_args


def main():
    parser = argparse.ArgumentParser(
        description="Extract frame-level embeddings from video and save to npz cache"
    )
    parser.add_argument(
        "--video",
        type=str,
        required=True,
        help="Path to the video file",
    )
    parser.add_argument(
        "--cache-dir",
        type=str,
        default="data",
        help="Base cache directory (default: data)",
    )
    parser.add_argument(
        "--skip-threshold",
        type=float,
        default=0.90,
        help="pHash similarity threshold for skipping frames (default: 0.90)",
    )
    parser.add_argument(
        "--max-gap-sec",
        type=float,
        default=5.0,
        help="Maximum seconds between retained frames (default: 5.0)",
    )
    parser.add_argument(
        "--frame-step",
        type=int,
        default=1,
        help="Analyze every Nth frame during dynamic sampling (default: 1)",
    )
    parser.add_argument(
        "--device",
        type=str,
        default="auto",
        choices=["cpu", "cuda", "auto"],
        help="Device to use for embedding (default: auto)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force recomputation even if cache exists",
    )
    # Add preprocessing arguments
    add_preprocess_args(parser)
    args = parser.parse_args()

    # Create preprocess config
    preprocess_config = PreprocessConfig.from_args(args)

    video_path = Path(args.video)
    if not video_path.exists():
        print(f"Error: Video file not found: {video_path}")
        sys.exit(1)

    cache_dir = Path(args.cache_dir)

    # Check if cache exists
    cache_path = FrameEmbeddingCache.get_cache_path(
        video_path,
        cache_dir,
        preprocess_config,
        skip_threshold=args.skip_threshold,
        max_gap_sec=args.max_gap_sec,
        frame_step=args.frame_step,
    )
    cache = None
    if not args.force:
        cache = FrameEmbeddingCache.load_valid(
            video_path,
            cache_dir,
            preprocess_config,
            skip_threshold=args.skip_threshold,
            max_gap_sec=args.max_gap_sec,
            frame_step=args.frame_step,
        )
    if cache is not None:
        print(f"  Cache exists: {cache_path}")
        print(f"  Loading from cache (use --force to recompute)")
    else:
        # Step 1: Dynamic frame sampling
        print(f"Dynamic frame sampling: {video_path}")
        print(f"  skip_threshold={args.skip_threshold}")
        print(f"  max_gap_sec={args.max_gap_sec}")
        print(f"  frame_step={max(1, int(args.frame_step))}")

        # Print preprocessing settings if non-default
        if preprocess_config.crop_black_borders or preprocess_config.resize_mode != "center_crop":
            print(f"  crop_black_borders={preprocess_config.crop_black_borders}")
            print(f"  resize_mode={preprocess_config.resize_mode.value}")
            print(f"  input_size={preprocess_config.input_size}")

        sampler = DynamicFrameSampler(
            skip_threshold=args.skip_threshold,
            max_gap_sec=args.max_gap_sec,
            frame_step=args.frame_step,
            cache_dir=cache_dir,
            preprocess_config=preprocess_config,
        )

        retained_frames = sampler.sample(video_path)
        print(f"  Retained {len(retained_frames)} frames")

        if len(retained_frames) == 0:
            print("Error: No frames retained from video")
            sys.exit(1)

        # Step 2 & 3: Extract embeddings and save to cache
        print(f"\nExtracting frame-level embeddings...")
        print(f"  device={args.device}")
        print(f"  cache_dir={cache_dir}")

        # Resolve device
        if args.device == "auto":
            import torch
            resolved_device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            resolved_device = args.device
        print(f"  resolved_device={resolved_device}")

        # Create embedder
        embedder = VideoEmbedder(device=resolved_device, preprocess_config=preprocess_config)

        # Embed frames with cache
        cache = embed_frames_with_cache(
            video_path=video_path,
            retained_frames=retained_frames,
            embedder=embedder,
            cache_dir=cache_dir,
            device=resolved_device,
            force=args.force,
            preprocess_config=preprocess_config,
            skip_threshold=args.skip_threshold,
            max_gap_sec=args.max_gap_sec,
            frame_step=args.frame_step,
        )
        print(f"  Saved cache to: {cache_path}")

    # Step 4: Print summary
    print(f"\nSummary:")
    print(f"  video_path: {cache.video_path}")
    print(f"  frame_count: {len(cache.frame_indices)}")
    print(f"  embedding_shape: {cache.embeddings.shape}")
    print(f"  embedding_dim: {cache.embeddings.shape[1] if cache.embeddings.ndim == 2 else 'N/A'}")
    print(f"  timestamps_range: [{cache.timestamps[0]:.2f}, {cache.timestamps[-1]:.2f}] seconds")
    print(f"  cache_path: {cache_path}")


if __name__ == "__main__":
    main()
