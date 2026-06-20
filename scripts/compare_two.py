#!/usr/bin/env python3
"""
Compare two videos script - Bidirectional containment detection between two videos.

Usage:
    python scripts/compare_two.py --video-a videos/HP.mp4 --video-b videos/HP_Trio.mp4 --cache-dir data --match-threshold 0.82 --top-k 10 --output data/reports/compare.json

Execution flow:
    1. If video feature cache doesn't exist, automatically do dynamic frame sampling and embedding extraction
    2. Load two npz caches
    3. Bidirectional comparison (A->B and B->A)
    4. Output JSON report
    5. Print a_in_b, b_in_a, relation to console
"""

import argparse
import json
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from video_sim.embedder import FrameEmbeddingCache, VideoEmbedder, embed_frames_with_cache
from video_sim.frame_sampler import DynamicFrameSampler
from video_sim.matcher import ContainmentResult, compare_videos_bidirectional
from video_sim.preprocess import PreprocessConfig, add_preprocess_args


def ensure_video_indexed(
    video_path: Path,
    cache_dir: Path,
    skip_threshold: float,
    max_gap_sec: float,
    frame_step: int,
    device: str,
    embedder: VideoEmbedder,
    force: bool = False,
    preprocess_config: PreprocessConfig = None,
) -> FrameEmbeddingCache:
    """
    Ensure a video is indexed (has frame embeddings cache).

    If cache doesn't exist or force=True, perform dynamic frame sampling and embedding extraction.

    Args:
        video_path: Path to the video file
        cache_dir: Base cache directory
        skip_threshold: pHash similarity threshold for skipping frames
        max_gap_sec: Maximum seconds between retained frames
        device: Device for embedding
        embedder: VideoEmbedder instance
        force: Force recomputation even if cache exists
        preprocess_config: Configuration for frame preprocessing

    Returns:
        FrameEmbeddingCache for the video
    """
    cache_path = FrameEmbeddingCache.get_cache_path(
        video_path,
        cache_dir,
        preprocess_config,
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
    )

    cache = None
    if not force:
        cache = FrameEmbeddingCache.load_valid(
            video_path,
            cache_dir,
            preprocess_config,
            skip_threshold=skip_threshold,
            max_gap_sec=max_gap_sec,
            frame_step=frame_step,
        )
    if cache is not None:
        print(f"  Loading cache: {cache_path}")
        return cache

    if force and cache_path.exists():
        print(f"  Force enabled, ignoring existing cache: {cache_path}")

    print(f"  Extracting features...")
    print(f"    Dynamic frame sampling (skip_threshold={skip_threshold}, max_gap_sec={max_gap_sec}, frame_step={frame_step})")

    sampler = DynamicFrameSampler(
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
        cache_dir=cache_dir,
        preprocess_config=preprocess_config,
    )
    retained_frames = sampler.sample(video_path)
    print(f"    Retained {len(retained_frames)} frames")

    if len(retained_frames) == 0:
        print(f"Error: No frames retained from {video_path}")
        sys.exit(1)

    print(f"    Extracting embeddings...")
    cache = embed_frames_with_cache(
        video_path=video_path,
        retained_frames=retained_frames,
            embedder=embedder,
            cache_dir=cache_dir,
            force=True,  # Always force when we get here (either force=True or cache doesn't exist)
            preprocess_config=preprocess_config,
            skip_threshold=skip_threshold,
            max_gap_sec=max_gap_sec,
            frame_step=frame_step,
        )
    print(f"    Saved cache: {cache_path}")

    return cache


def main():
    parser = argparse.ArgumentParser(
        description="Bidirectional containment detection between two videos"
    )
    parser.add_argument(
        "--video-a",
        type=str,
        required=True,
        help="Path to video A",
    )
    parser.add_argument(
        "--video-b",
        type=str,
        required=True,
        help="Path to video B",
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
        "--match-threshold",
        type=float,
        default=0.65,
        help="Minimum similarity threshold for a match (default: 0.65)",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=10,
        help="Number of top results to retrieve per query (default: 10)",
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
        help="Force re-extraction of embeddings, ignoring existing cache",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output JSON file path (default: print to stdout)",
    )
    # Add preprocessing arguments
    add_preprocess_args(parser)
    args = parser.parse_args()

    # Create preprocess config
    preprocess_config = PreprocessConfig.from_args(args)

    video_a_path = Path(args.video_a)
    video_b_path = Path(args.video_b)
    cache_dir = Path(args.cache_dir)

    if not video_a_path.exists():
        print(f"Error: Video A not found: {video_a_path}")
        sys.exit(1)
    if not video_b_path.exists():
        print(f"Error: Video B not found: {video_b_path}")
        sys.exit(1)

    # Resolve device
    if args.device == "auto":
        import torch
        resolved_device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        resolved_device = args.device
    print(f"Device: {resolved_device}")

    # Print preprocessing settings if non-default
    if preprocess_config.crop_black_borders or preprocess_config.resize_mode != "center_crop":
        print(f"Preprocessing: crop_black_borders={preprocess_config.crop_black_borders}, "
              f"resize_mode={preprocess_config.resize_mode.value}, "
              f"input_size={preprocess_config.input_size}")

    # Create embedder (will be reused for both videos)
    print("Initializing embedder...")
    embedder = VideoEmbedder(device=resolved_device, preprocess_config=preprocess_config)

    # Ensure both videos are indexed
    print(f"\nIndexing video A: {video_a_path.name}")
    cache_a = ensure_video_indexed(
        video_a_path, cache_dir, args.skip_threshold, args.max_gap_sec,
        args.frame_step, resolved_device, embedder, args.force, preprocess_config
    )
    print(f"  Frames: {len(cache_a.frame_indices)}")

    print(f"\nIndexing video B: {video_b_path.name}")
    cache_b = ensure_video_indexed(
        video_b_path, cache_dir, args.skip_threshold, args.max_gap_sec,
        args.frame_step, resolved_device, embedder, args.force, preprocess_config
    )
    print(f"  Frames: {len(cache_b.frame_indices)}")

    # Perform bidirectional comparison
    print(f"\nPerforming bidirectional comparison...")
    print(f"  match_threshold={args.match_threshold}")
    print(f"  top_k={args.top_k}")

    result = compare_videos_bidirectional(
        cache_a=cache_a,
        cache_b=cache_b,
        match_threshold=args.match_threshold,
        top_k=args.top_k,
    )

    # Print summary to console
    print("\n" + "=" * 60)
    print(f"Video A: {video_a_path.name} ({result.total_frames_a} frames)")
    print(f"Video B: {video_b_path.name} ({result.total_frames_b} frames)")
    print(f"Duration: A={result.duration_a:.1f}s, B={result.duration_b:.1f}s")
    print(f"Threshold: {args.match_threshold}")
    print("-" * 60)
    print(f"a_in_b:                 {result.a_in_b:.4f}")
    print(f"b_in_a:                 {result.b_in_a:.4f}")
    print(f"symmetric_similarity:   {result.symmetric_similarity:.4f}")
    print(f"avg_similarity_a_to_b:  {result.avg_similarity_a_to_b:.4f}")
    print(f"avg_similarity_b_to_a:  {result.avg_similarity_b_to_a:.4f}")
    print(f"relation:               {result.relation}")
    print(f"matches_a_to_b:         {len(result.matches_a_to_b)}")
    print(f"matches_b_to_a:         {len(result.matches_b_to_a)}")
    print("-" * 60)
    print("Raw similarity statistics (best-match per frame):")
    print(f"  max:   {result.raw_similarity_max:.4f}")
    print(f"  mean:  {result.raw_similarity_mean:.4f}")
    print(f"  p95:   {result.raw_similarity_p95:.4f}")
    print(f"  p99:   {result.raw_similarity_p99:.4f}")
    print("=" * 60)

    # Output JSON
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result.to_dict(), f, indent=2, ensure_ascii=False)
        print(f"\nSaved report to: {output_path}")


if __name__ == "__main__":
    main()
