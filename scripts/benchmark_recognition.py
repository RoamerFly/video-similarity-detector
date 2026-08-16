#!/usr/bin/env python3
"""Run a lightweight, repeatable recognition micro-benchmark.

The default mode uses deterministic synthetic embeddings, so it can measure
candidate selection, exact FAISS matching and segment aggregation without
downloading a model or requiring sample videos.  A JSON result is written for
before/after comparisons.  Model/video benchmarking is deliberately opt-in
and reports a clear skip reason when local assets are unavailable.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import platform
import sys
import types

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    import decord  # noqa: F401
except ImportError:
    decord_stub = types.ModuleType("decord")
    decord_stub.VideoReader = object
    decord_stub.cpu = lambda *_args, **_kwargs: None
    sys.modules["decord"] = decord_stub

from video_sim.candidate_selector import select_candidate_pairs
from video_sim.embedder import FrameEmbeddingCache
from video_sim.indexer import build_frame_index
from video_sim.matcher import compare_frame_indexes_bidirectional
from video_sim.metrics import RecognitionMetrics
from video_sim.segmenter import aggregate_segments


def _normalise(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype="float32")
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    return values / np.where(norms == 0, 1.0, norms)


def _synthetic_caches(video_count: int, frames_per_video: int, dimension: int, seed: int):
    rng = np.random.default_rng(seed)
    caches = {}
    for video_id in range(video_count):
        base = rng.normal(size=(frames_per_video, dimension)).astype("float32")
        if video_id % 3 == 1:
            base = base + 0.12 * np.roll(base, 1, axis=0)
        embeddings = _normalise(base)
        path = Path(f"synthetic_video_{video_id:03d}.mp4")
        caches[path] = FrameEmbeddingCache(
            video_path=str(path),
            frame_indices=np.arange(frames_per_video, dtype=np.int64),
            timestamps=np.arange(frames_per_video, dtype=np.float32),
            phashes=[f"p{video_id}_{frame}" for frame in range(frames_per_video)],
            thumbnail_paths=[],
            embeddings=embeddings,
            metadata={"synthetic": True},
        )
    return caches


def run_synthetic(args) -> dict:
    metrics = RecognitionMetrics()
    caches = _synthetic_caches(args.videos, args.frames, args.dimension, args.seed)
    with metrics.stage("candidate", items=len(caches)):
        selection = select_candidate_pairs(
            caches,
            candidate_limit=args.candidate_limit,
            match_threshold=args.match_threshold,
        )
    metrics.set_count("videos", len(caches))
    metrics.set_count("candidate_pairs", len(selection.pairs))

    indexed = {path: build_frame_index(cache) for path, cache in caches.items()}
    pairs = selection.pairs or list(caches)[:2]
    exact_result = None
    if len(pairs) > 0:
        video_a, video_b = pairs[0]
        with metrics.stage(
            "exact_compare",
            items=len(caches[video_a].embeddings) + len(caches[video_b].embeddings),
        ):
            exact_result = compare_frame_indexes_bidirectional(
                cache_a=caches[video_a],
                cache_b=caches[video_b],
                index_a=indexed[video_a],
                index_b=indexed[video_b],
                match_threshold=args.match_threshold,
                top_k=args.top_k,
            )

    match_points = [] if exact_result is None else exact_result.matches_a_to_b + exact_result.matches_b_to_a
    with metrics.stage("segment", items=len(match_points)):
        segments = aggregate_segments(
            match_points,
            min_segment_duration=0.0,
            min_segment_matches=1,
        )
    metrics.set_count("matches", len(match_points))
    metrics.set_count("segments", len(segments))
    metrics.snapshot_resources()
    payload = metrics.to_dict()
    # Keep the old top-level elapsed_ms alias while making the wall-clock
    # meaning explicit. Stage values remain accumulated worker time.
    payload["elapsed_ms"] = payload["wall_elapsed_ms"]
    payload.update(
        {
            "mode": "synthetic",
            "status": "ok",
            "config": {
                "videos": args.videos,
                "frames": args.frames,
                "dimension": args.dimension,
                "candidate_limit": args.candidate_limit,
                "match_threshold": args.match_threshold,
                "top_k": args.top_k,
                "seed": args.seed,
            },
            "model_benchmark": {
                "status": "skipped",
                "reason": "synthetic mode does not load a CLIP model; use the application run for model timing",
            },
        }
    )
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["synthetic"], default="synthetic")
    parser.add_argument("--videos", type=int, default=12)
    parser.add_argument("--frames", type=int, default=96)
    parser.add_argument("--dimension", type=int, default=32)
    parser.add_argument("--candidate-limit", type=int, default=3)
    parser.add_argument("--match-threshold", type=float, default=0.65)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--seed", type=int, default=20260814)
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "data" / "benchmarks" / "recognition_synthetic.json",
    )
    args = parser.parse_args()
    if min(args.videos, args.frames, args.dimension) <= 0:
        parser.error("videos, frames and dimension must be positive")
    result = run_synthetic(args)
    result["environment"] = {"python": platform.python_version(), "platform": platform.platform()}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"Benchmark JSON: {args.output}")


if __name__ == "__main__":
    main()
