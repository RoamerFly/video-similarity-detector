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

from video_sim.embedder import (
    FrameEmbeddingCache,
    VideoEmbedder,
    embed_frames_with_cache,
)
from video_sim.frame_sampler import DynamicFrameSampler
from video_sim.matcher import ContainmentResult, compare_videos_bidirectional
from video_sim.preprocess import PreprocessConfig, add_preprocess_args
from video_sim.recognition_contract import (
    CONTAINMENT_SCORING_VERSION,
    FEATURE_EXTRACTOR_ID,
    REPORT_SCHEMA_VERSION,
)
from video_sim.segmenter import aggregate_bidirectional_segments
from video_sim.segment_refiner import (
    RefinementConfig,
    refinement_failure_payload,
    refine_segments,
)


def _segment_refinement_config_from_args(args) -> RefinementConfig:
    return RefinementConfig(
        mode=args.segment_refinement_mode,
        sample_step_sec=args.segment_refinement_sample_step_sec,
        padding_sec=args.segment_refinement_padding_sec,
        search_radius_sec=args.segment_refinement_search_radius_sec,
        max_segments=args.segment_refinement_max_segments,
        max_frames=args.segment_refinement_max_frames,
        max_wall_sec=args.segment_refinement_max_wall_sec,
        max_frame_pixels=args.segment_refinement_max_frame_pixels,
        pixel_threshold=args.segment_refinement_pixel_threshold,
        min_support=args.segment_refinement_min_support,
        min_temporal_change=args.segment_refinement_min_temporal_change,
    )


def refine_pair_segments_with_fallback(
    video_a,
    video_b,
    segments,
    *,
    config,
    preprocess_config=None,
):
    """Run optional local refinement while preserving coarse report data."""

    if config.mode == "off":
        return None, None
    try:
        return (
            refine_segments(
                video_a,
                video_b,
                segments,
                config=config,
                preprocess_config=preprocess_config,
            ),
            None,
        )
    except Exception as refinement_error:
        return (
            refinement_failure_payload(
                segments,
                config=config,
                reason=f"{type(refinement_error).__name__}:{refinement_error}",
            ),
            refinement_error,
        )


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
            embedding_runtime=embedder.embedding_runtime_fingerprint(),
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
    print(f"    Extracting embeddings...")
    cache = embed_frames_with_cache(
        video_path=video_path,
        retained_frames=None,
        sampler=sampler,
        embedder=embedder,
        cache_dir=cache_dir,
        force=True,  # Always force when we get here (either force=True or cache doesn't exist)
        preprocess_config=preprocess_config,
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
        source_duration_sec=sampler.source_duration_sec,
        embedding_runtime=embedder.embedding_runtime_fingerprint(),
    )
    print(f"    Retained {len(cache.frame_indices)} frames")
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
        "--offset-tolerance",
        type=float,
        default=3.0,
        help="Maximum temporal offset drift for verified matches (default: 3.0s)",
    )
    parser.add_argument(
        "--segment-refinement-mode",
        type=str,
        default="off",
        choices=["off", "copy", "copy-mirror"],
        help="Optional decode-only local segment evidence (default: off)",
    )
    parser.add_argument(
        "--segment-refinement-sample-step-sec",
        type=float,
        default=0.25,
        help="Local refinement sample step in seconds (default: 0.25)",
    )
    parser.add_argument(
        "--segment-refinement-padding-sec",
        type=float,
        default=1.0,
        help="Local refinement padding around a coarse segment (default: 1.0)",
    )
    parser.add_argument(
        "--segment-refinement-search-radius-sec",
        type=float,
        default=0.5,
        help="Local target search radius in seconds (default: 0.5)",
    )
    parser.add_argument(
        "--segment-refinement-max-segments",
        type=int,
        default=4,
        help="Maximum coarse segments refined per pair (default: 4)",
    )
    parser.add_argument(
        "--segment-refinement-max-frames",
        type=int,
        default=256,
        help="Pair-wide raw frame read-attempt budget (default: 256)",
    )
    parser.add_argument(
        "--segment-refinement-max-wall-sec",
        type=float,
        default=5.0,
        help="Soft wall-clock budget per pair refinement (default: 5)",
    )
    parser.add_argument(
        "--segment-refinement-max-frame-pixels",
        type=int,
        default=8_294_400,
        help="Maximum pixels in one raw decoded refinement frame (default: 8294400)",
    )
    parser.add_argument(
        "--segment-refinement-pixel-threshold",
        type=float,
        default=0.92,
        help="Minimum local pixel/structure score (default: 0.92)",
    )
    parser.add_argument(
        "--segment-refinement-min-support",
        type=int,
        default=3,
        help="Minimum continuous supporting frames (default: 3)",
    )
    parser.add_argument(
        "--segment-refinement-min-temporal-change",
        type=float,
        default=0.02,
        help="Minimum per-side temporal descriptor change (default: 0.02)",
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
    try:
        segment_refinement_config = _segment_refinement_config_from_args(args)
    except (TypeError, ValueError) as exc:
        parser.error(f"invalid segment refinement configuration: {exc}")

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
        offset_tolerance_sec=args.offset_tolerance,
    )
    if bool(getattr(result, "alignment_computed", False)):
        # Temporal alignment is authoritative once computed, including the
        # empty-evidence case.  Never fall back to raw Top-K matches here.
        matches_a_to_b = list(getattr(result, "verified_matches_a_to_b", []))
        matches_b_to_a = list(getattr(result, "verified_matches_b_to_a", []))
    else:
        matches_a_to_b = result.matches_a_to_b
        matches_b_to_a = result.matches_b_to_a
    # Keep the single-pair CLI on the same direction-aware segment path as
    # batch_compare: aggregate A→B and B→A independently, then normalize and
    # fuse them in A/B coordinates.
    segments = aggregate_bidirectional_segments(
        matches_a_to_b,
        matches_b_to_a,
        source_timestamps_a=cache_a.timestamps,
        source_timestamps_b=cache_b.timestamps,
        total_source_duration_a=result.duration_a,
        total_source_duration_b=result.duration_b,
    )
    segment_refinement = None
    if segment_refinement_config.mode != "off":
        segment_refinement, refinement_error = refine_pair_segments_with_fallback(
            video_a_path,
            video_b_path,
            segments,
            config=segment_refinement_config,
            preprocess_config=preprocess_config,
        )
        if refinement_error is not None:
            print(
                "Warning: local segment refinement failed; preserving coarse segments: "
                f"{type(refinement_error).__name__}: {refinement_error}"
            )
        if segment_refinement is not None:
            segment_refinement = {
                **segment_refinement,
                "preprocess_config": preprocess_config.to_dict(),
            }

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
    print(f"matched_segments:       {len(segments)}")
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
        report = result.to_dict()
        report.update(
            {
                "report_schema_version": REPORT_SCHEMA_VERSION,
                "containment_scoring_version": CONTAINMENT_SCORING_VERSION,
                "feature_extractor_id": FEATURE_EXTRACTOR_ID,
                "match_threshold": args.match_threshold,
                "top_k": args.top_k,
                "offset_tolerance": args.offset_tolerance,
            }
        )
        report["segments"] = [segment.to_dict() for segment in segments]
        if segment_refinement is not None:
            report["segment_refinement"] = segment_refinement
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        print(f"\nSaved report to: {output_path}")


if __name__ == "__main__":
    main()
