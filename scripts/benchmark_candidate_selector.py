#!/usr/bin/env python3
"""Synthetic candidate-recall benchmark (baseline versus bounded sketch)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import platform
import subprocess
import sys
import time
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

from video_sim.candidate_selector import estimate_auxiliary_memory_bytes, select_candidate_pairs
from video_sim.embedder import FrameEmbeddingCache
from video_sim.metrics import process_memory_snapshot


def _normalise(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype="float32")
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    return values / np.where(norms == 0, 1.0, norms)


def _cache(path: Path, values: np.ndarray) -> FrameEmbeddingCache:
    values = _normalise(values)
    return FrameEmbeddingCache(
        video_path=str(path),
        frame_indices=np.arange(len(values), dtype=np.int64),
        timestamps=np.arange(len(values), dtype="float32"),
        # Invalid pHash strings deliberately select the SimHash channel.  The
        # benchmark therefore measures the compressed embedding auxiliary
        # path, not an accidental pHash shortcut.
        phashes=[f"simhash-placeholder-{index}" for index in range(len(values))],
        thumbnail_paths=[],
        embeddings=values,
    )


def _pair(paths: list[Path], left_id: int, right_id: int) -> tuple[Path, Path]:
    return tuple(sorted((paths[left_id], paths[right_id])))


def _synthetic_dataset(
    video_count: int,
    frames: int,
    dimension: int,
    seed: int,
):
    """Build varied containment and negative cases without real model files.

    Short sources are 4/8/16/32 frames and are inserted at independently
    seeded positions in long targets.  Positions deliberately cross window
    boundaries and are not tied to sketch quantiles.  The returned labels are
    kept by type so a single aggregate recall cannot hide a missed case class.
    """
    rng = np.random.default_rng(seed)
    short_count = max(8, min(32, video_count // 4))
    long_start = short_count
    paths = [ROOT / "data" / "benchmarks" / f"candidate_{i:03d}.mp4" for i in range(video_count)]
    values_by_id: list[np.ndarray] = []
    for video_id in range(video_count):
        if video_id < short_count:
            length = (4, 8, 16, 32)[video_id % 4]
        else:
            # Vary long-video lengths, including non-multiples of the 100 s
            # benchmark window, to avoid a fixed bucket-shaped fixture.
            length = max(100, frames + ((video_id * 137) % max(1, frames // 2)))
        values_by_id.append(rng.normal(size=(length, dimension)).astype("float32"))

    positive_by_type: dict[str, set[tuple[Path, Path]]] = {}

    def add_positive(
        label: str,
        source_id: int,
        target_ids: int | list[int],
        clip_length: int,
        noise: float = 0.0,
    ) -> None:
        if source_id >= short_count:
            return
        targets = [target_ids] if isinstance(target_ids, int) else target_ids
        clip = _normalise(rng.normal(size=(clip_length, dimension)).astype("float32"))
        values_by_id[source_id][:] = clip
        for target_id in targets:
            if target_id >= video_count or target_id < long_start:
                continue
            target = values_by_id[target_id]
            max_start = max(1, len(target) - clip_length)
            # A different position per target; at least one case is in the
            # middle of a bucket rather than a quantile/bucket boundary.
            position = (37 + target_id * 113 + clip_length * 17) % max_start
            segment = clip.copy()
            if noise:
                segment += rng.normal(scale=noise, size=segment.shape).astype("float32")
            target[position : position + clip_length] = segment
            values_by_id[target_id] = target
            positive_by_type.setdefault(label, set()).add(_pair(paths, source_id, target_id))

    add_positive("exact_4_frame", 0, long_start, 4)
    add_positive("noisy_8_frame", 1, long_start + 1, 8, noise=0.008)
    add_positive("shifted_16_frame", 2, long_start + 2, 16)
    add_positive("varied_32_frame", 3, long_start + 3, 32, noise=0.012)
    add_positive("repeated_clip", 4, [long_start + 4, long_start + 5], 4, noise=0.006)
    add_positive("non_quantile_position", 5, long_start + 6, 8, noise=0.004)
    add_positive("different_length_target", 6, long_start + 7, 16, noise=0.01)

    # Explicit negatives exercise the failure modes of a frame-only shortcut.
    negative_by_type: dict[str, set[tuple[Path, Path]]] = {}
    negative_source = 7 % short_count
    negative_clip = _normalise(
        rng.normal(size=(len(values_by_id[negative_source]), dimension)).astype("float32")
    )
    values_by_id[negative_source][:] = negative_clip
    peak_target = long_start + 8
    values_by_id[peak_target][17] = negative_clip[0]
    negative_by_type["single_random_peak"] = {_pair(paths, negative_source, peak_target)}

    shuffled_target = long_start + 9
    positions = rng.choice(len(values_by_id[shuffled_target]), size=len(negative_clip), replace=False)
    for source_frame, target_frame in zip(range(len(negative_clip)), positions):
        values_by_id[shuffled_target][target_frame] = negative_clip[source_frame]
    negative_by_type["target_time_random"] = {_pair(paths, negative_source, shuffled_target)}

    semantic_target = long_start + 10
    semantic_position = 211 % max(1, len(values_by_id[semantic_target]) - len(negative_clip))
    values_by_id[semantic_target][semantic_position : semantic_position + len(negative_clip)] = (
        negative_clip + rng.normal(scale=0.22, size=negative_clip.shape).astype("float32")
    )
    negative_by_type["semantic_near_no_continuity"] = {
        _pair(paths, negative_source, semantic_target)
    }

    caches = {path: _cache(path, values) for path, values in zip(paths, values_by_id)}
    return caches, positive_by_type, negative_by_type


def _run(caches, positive_by_type, negative_by_type, mode: str, candidate_limit: int) -> dict:
    before = process_memory_snapshot()
    started = time.perf_counter()
    selection = select_candidate_pairs(
        caches,
        candidate_limit=candidate_limit,
        match_threshold=0.8,
        representatives_per_video=64,
        max_index_frames_per_video=64,
        window_seconds=100.0,
        max_windows_per_video=16,
        sketch_mode=mode,
    )
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    after = process_memory_snapshot()
    peak_before = before.get("peak_rss_bytes") or before.get("current_rss_bytes") or 0
    peak_after = after.get("peak_rss_bytes") or after.get("current_rss_bytes") or 0
    selected = set(selection.pairs)
    positive_counts = {
        label: {
            "total": len(pairs),
            "recalled": sum(pair in selected for pair in pairs),
            "recall": sum(pair in selected for pair in pairs) / max(1, len(pairs)),
        }
        for label, pairs in positive_by_type.items()
    }
    positive_pairs = set().union(*positive_by_type.values()) if positive_by_type else set()
    negative_counts = {
        label: {
            "total": len(pairs),
            "selected": sum(pair in selected for pair in pairs),
        }
        for label, pairs in negative_by_type.items()
    }
    recalled_positive_pairs = sum(pair in selected for pair in positive_pairs)
    negative_pair_count = sum(item["selected"] for item in negative_counts.values())
    auxiliary_memory = estimate_auxiliary_memory_bytes(caches)
    sketch_peak_frames = max(
        (min(len(cache.embeddings), 64) for cache in caches.values()),
        default=0,
    )
    embedding_dimension = next(
        (int(np.asarray(cache.embeddings).shape[1]) for cache in caches.values() if len(cache.embeddings)),
        0,
    )
    sketch_peak_bytes = sketch_peak_frames * embedding_dimension * 4
    return {
        "mode": mode,
        "positive_pairs": len(positive_pairs),
        "recalled_positive_pairs": recalled_positive_pairs,
        "recall_at_candidate_limit": recalled_positive_pairs / max(1, len(positive_pairs)),
        "recall_by_positive_type": positive_counts,
        "negative_pairs": sum(item["total"] for item in negative_counts.values()),
        "selected_negative_pairs": negative_pair_count,
        "negative_selected_by_type": negative_counts,
        "false_candidate_ratio": negative_pair_count / max(1, sum(item["total"] for item in negative_counts.values())),
        "candidate_pairs": len(selection.pairs),
        "all_pair_count": selection.all_pair_count,
        "pair_retention_ratio": len(selection.pairs) / max(1, selection.all_pair_count),
        "wall_elapsed_ms": round(elapsed_ms, 3),
        "rss_peak_delta_bytes": max(0, int(peak_after) - int(peak_before)),
        "auxiliary_memory_estimate": auxiliary_memory,
        "sketch_peak_frames_per_video": int(sketch_peak_frames),
        "sketch_peak_bytes_per_video": int(sketch_peak_bytes),
        "candidate_memory_estimate_bytes": int(
            auxiliary_memory["estimated_bytes"] + sketch_peak_bytes * len(caches)
        ),
    }


def _run_worker(args) -> None:
    caches, positive_by_type, negative_by_type = _synthetic_dataset(
        args.videos, args.frames, args.dimension, args.seed
    )
    print(
        json.dumps(
            _run(caches, positive_by_type, negative_by_type, args.mode, args.candidate_limit),
            ensure_ascii=False,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--videos", type=int, default=128)
    parser.add_argument("--frames", type=int, default=1000)
    parser.add_argument("--dimension", type=int, default=32)
    parser.add_argument("--candidate-limit", type=int, default=5)
    parser.add_argument("--seed", type=int, default=20260814)
    parser.add_argument("--mode", choices=["baseline", "optimized"], default=None)
    parser.add_argument("--worker", action="store_true")
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "data" / "benchmarks" / "candidate_selector_stage4.json",
    )
    args = parser.parse_args()
    if args.videos < 64 or args.frames < 100:
        parser.error("benchmark requires at least 64 videos and 100 frames")
    if args.worker:
        _run_worker(args)
        return
    common = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--videos", str(args.videos),
        "--frames", str(args.frames),
        "--dimension", str(args.dimension),
        "--candidate-limit", str(args.candidate_limit),
        "--seed", str(args.seed),
        "--worker",
    ]
    baseline = json.loads(
        subprocess.run(common + ["--mode", "baseline"], capture_output=True, text=True, check=True).stdout
    )
    optimized = json.loads(
        subprocess.run(common + ["--mode", "optimized"], capture_output=True, text=True, check=True).stdout
    )
    if optimized["recall_at_candidate_limit"] < baseline["recall_at_candidate_limit"]:
        raise RuntimeError("optimized candidate recall regressed against baseline")
    if optimized["pair_retention_ratio"] >= 0.5:
        raise RuntimeError("candidate screening no longer provides meaningful pair reduction")
    result = {
        "mode": "synthetic_candidate_selector",
        "status": "ok",
        "config": vars(args) | {"output": str(args.output)},
        "baseline": baseline,
        "optimized": optimized,
        "environment": {"python": platform.python_version(), "platform": platform.platform()},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"Benchmark JSON: {args.output}")


if __name__ == "__main__":
    main()
