#!/usr/bin/env python3
"""Benchmark temporal segment aggregation with deterministic FrameMatch data.

This benchmark intentionally exercises the direction-local, single-pass
clustering path.  It reports wall time and the run-level RSS baseline/peak
delta so changes can be compared without a model or sample video.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import platform
import sys
from statistics import median
import time
import types

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    import decord  # noqa: F401
except ImportError:
    decord_stub = types.ModuleType("decord")
    decord_stub.VideoReader = object
    decord_stub.cpu = lambda *_args, **_kwargs: None
    sys.modules["decord"] = decord_stub

from video_sim.matcher import FrameMatch
from video_sim.metrics import RecognitionMetrics
from video_sim.segmenter import aggregate_segments


def _matches(count: int) -> list[FrameMatch]:
    return [
        FrameMatch(
            source_video="synthetic-a.mp4",
            target_video="synthetic-b.mp4",
            source_frame_index=index,
            target_frame_index=index + 17,
            source_timestamp=float(index),
            target_timestamp=float(index + 17),
            similarity=0.9,
        )
        for index in range(count)
    ]


def _run_case(count: int) -> dict:
    metrics = RecognitionMetrics()
    matches = _matches(count)
    timeline = list(range(count))
    algorithm_times = []
    with metrics.stage("segment", items=len(matches)):
        # Warm up once, then use the median of repeated in-process calls to
        # avoid reporting allocator/import noise as algorithm complexity.
        segments = aggregate_segments(
            matches,
            source_timestamps=timeline,
            total_source_duration=float(count),
            min_segment_duration=5.0,
            min_segment_matches=3,
        )
        for _ in range(3):
            algorithm_started = time.perf_counter()
            segments = aggregate_segments(
                matches,
                source_timestamps=timeline,
                total_source_duration=float(count),
                min_segment_duration=5.0,
                min_segment_matches=3,
            )
            algorithm_times.append((time.perf_counter() - algorithm_started) * 1000.0)
    algorithm_wall_elapsed_ms = median(algorithm_times)
    metrics.set_count("matches", len(matches))
    metrics.set_count("segments", len(segments))
    payload = metrics.to_dict()
    stage = payload["stages"]["segment"]
    return {
        "matches": count,
        "segments": len(segments),
        "wall_elapsed_ms": payload.get("wall_elapsed_ms"),
        "algorithm_wall_elapsed_ms": round(algorithm_wall_elapsed_ms, 3),
        "segment_accumulated_elapsed_ms": stage.get("accumulated_elapsed_ms"),
        "baseline_rss_bytes": payload.get("baseline_rss_bytes"),
        "observed_peak_rss_bytes": payload.get("observed_peak_rss_bytes"),
        "peak_rss_delta_bytes": payload.get("peak_rss_delta_bytes"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matches", type=int, default=10000)
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "data" / "benchmarks" / "temporal_segments_stage3.json",
    )
    args = parser.parse_args()
    if args.matches < 10000:
        parser.error("--matches must be at least 10000")

    half = _run_case(max(5000, args.matches // 2))
    full = _run_case(args.matches)
    half_ms = float(half["algorithm_wall_elapsed_ms"] or 0.0)
    full_ms = float(full["algorithm_wall_elapsed_ms"] or 0.0)
    algorithm_ratio = (full_ms / half_ms) if half_ms > 0 else None
    if algorithm_ratio is not None and algorithm_ratio >= 2.8:
        raise RuntimeError(
            f"temporal aggregation scaling exceeded near-linear limit: {algorithm_ratio:.3f}"
        )
    result = {
        "mode": "synthetic_temporal_segments",
        "status": "ok",
        "algorithm": "source-ordered clustering with bounded target slope; no pairwise matrix",
        "case": full,
        "scaling": {
            "half_case": half,
            "algorithm_wall_time_ratio_full_over_half": algorithm_ratio,
        },
        "environment": {"python": platform.python_version(), "platform": platform.platform()},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"Benchmark JSON: {args.output}")


if __name__ == "__main__":
    main()
