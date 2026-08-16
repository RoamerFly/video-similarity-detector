#!/usr/bin/env python3
"""Independent-process benchmark for compact candidate summaries and exact pool."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import types
import time

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

from video_sim.candidate_selector import (
    build_candidate_summary,
    estimate_auxiliary_memory_bytes,
    select_candidate_pairs,
)
from video_sim.embedder import FrameEmbeddingCache
from video_sim.indexer import build_frame_index
from video_sim.matcher import compare_frame_indexes_bidirectional
from video_sim.metrics import process_memory_snapshot
from video_sim.resource_pool import ExactResourcePool
from video_sim.segmenter import aggregate_bidirectional_segments


PROFILE_CONFIGS = {
    # Smoke deliberately exercises the smallest supported shape.  Its
    # per-video candidate summaries are a larger fraction of the total, so it
    # reports the measured ratio but does not pretend that it is a scale gate.
    "smoke": {
        "videos": 8,
        "frames": 1024,
        "dimension": 256,
        "memory_gate": False,
    },
    "scale": {
        "videos": 24,
        "frames": 4096,
        "dimension": 512,
        "memory_gate": True,
    },
}


def _normalise(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype="float32")
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    return values / np.where(norms == 0, 1.0, norms)


def _prepare_artifacts(root: Path, video_count: int, frames: int, dimension: int, seed: int):
    rng = np.random.default_rng(seed)
    video_paths = [root / f"video_{index:03d}.mp4" for index in range(video_count)]
    artifact_paths = [root / f"cache_{index:03d}.npz" for index in range(video_count)]
    values = [_normalise(rng.normal(size=(frames, dimension)).astype("float32")) for _ in video_paths]
    values[1][80:128] = values[0][0:48]
    for video_path, artifact_path, embeddings in zip(video_paths, artifact_paths, values):
        cache = FrameEmbeddingCache(
            video_path=str(video_path),
            frame_indices=np.arange(len(embeddings), dtype=np.int64),
            timestamps=np.arange(len(embeddings), dtype="float32"),
            phashes=[f"simhash-placeholder-{index}" for index in range(len(embeddings))],
            thumbnail_paths=[],
            embeddings=embeddings,
        )
        cache.save(artifact_path)
    return video_paths, artifact_paths


def _exact_digest(cache_a, index_a, cache_b, index_b):
    result = compare_frame_indexes_bidirectional(
        cache_a=cache_a,
        cache_b=cache_b,
        index_a=index_a,
        index_b=index_b,
        match_threshold=0.8,
        top_k=1,
        early_stop=False,
    )
    segments = aggregate_bidirectional_segments(
        result.matches_a_to_b,
        result.matches_b_to_a,
        source_timestamps_a=cache_a.timestamps,
        source_timestamps_b=cache_b.timestamps,
        total_source_duration_a=float(cache_a.timestamps[-1]),
        total_source_duration_b=float(cache_b.timestamps[-1]),
        min_segment_duration=1.0,
        min_segment_matches=2,
    )
    def portable(value):
        if isinstance(value, dict):
            return {
                key: (
                    Path(item).name
                    if key in {"video_a", "video_b", "source_video", "target_video"}
                    and isinstance(item, str)
                    else portable(item)
                )
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [portable(item) for item in value]
        return value

    return {
        "result": portable(result.to_dict()),
        "segments": [segment.to_dict() for segment in segments],
    }


def _json_digest(value) -> str:
    """Return a compact, deterministic digest for a potentially large result."""

    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _benchmark_pairs(video_paths: list[Path]) -> list[tuple[int, int]]:
    """Choose a small deterministic set that also exercises pool eviction."""

    pairs = [(0, 1)]
    if len(video_paths) >= 3:
        pairs.extend(((1, 2), (0, 2)))
    return pairs


def _run_worker(args) -> dict:
    temporary = None
    if args.artifact_root:
        root = Path(args.artifact_root)
        video_paths = [root / f"video_{index:03d}.mp4" for index in range(args.videos)]
        artifact_paths = [root / f"cache_{index:03d}.npz" for index in range(args.videos)]
    else:
        temporary = tempfile.TemporaryDirectory(prefix="video-sim-pool-")
        root = Path(temporary.name)
        video_paths, artifact_paths = _prepare_artifacts(
            root, args.videos, args.frames, args.dimension, args.seed
        )
    try:
        gc.collect()
        before = process_memory_snapshot()
        started = time.perf_counter()
        if args.mode == "legacy":
            caches = {
                video_path: FrameEmbeddingCache.load(artifact_path)
                for video_path, artifact_path in zip(video_paths, artifact_paths)
            }
            selection = select_candidate_pairs(
                caches,
                candidate_limit=4,
                match_threshold=0.8,
                representatives_per_video=64,
                max_index_frames_per_video=512,
            )
            indexes = {
                path: build_frame_index(cache) for path, cache in caches.items()
            }
            exact_values = [
                _exact_digest(
                    caches[video_paths[left]],
                    indexes[video_paths[left]],
                    caches[video_paths[right]],
                    indexes[video_paths[right]],
                )
                for left, right in _benchmark_pairs(video_paths)
            ]
            exact_digest = _json_digest(exact_values)
            resident_videos = len(caches)
            resident_bytes = sum(
                int(cache.embeddings.nbytes)
                + int(indexes[path].index.ntotal)
                * int(getattr(indexes[path].index, "d", 0) or 0)
                * 4
                for path, cache in caches.items()
            )
            pool_stats = {
                "hits": 0,
                "misses": len(caches),
                "evictions": 0,
                "resident_videos": resident_videos,
                "peak_resident_videos": resident_videos,
                "estimated_resident_bytes": resident_bytes,
                "capacity": resident_videos,
            }
        else:
            summaries = {}
            for video_path, artifact_path in zip(video_paths, artifact_paths):
                cache = FrameEmbeddingCache.load(artifact_path)
                summaries[video_path] = build_candidate_summary(
                    cache,
                    representatives_per_video=64,
                    max_index_frames_per_video=512,
                )
                del cache
            selection = select_candidate_pairs(
                summaries,
                candidate_limit=4,
                match_threshold=0.8,
                representatives_per_video=64,
                max_index_frames_per_video=512,
            )
            pool = ExactResourcePool(max_resident_videos=2)
            exact_values = []
            peak_pool_resident_bytes = 0
            peak_pool_resident_videos = 0
            for left, right in _benchmark_pairs(video_paths):
                with pool.acquire_pair(
                    artifact_paths[left], artifact_paths[right]
                ) as (resource_a, resource_b):
                    current_pool_stats = pool.stats()
                    peak_pool_resident_bytes = max(
                        peak_pool_resident_bytes,
                        int(current_pool_stats["estimated_resident_bytes"]),
                    )
                    peak_pool_resident_videos = max(
                        peak_pool_resident_videos,
                        int(current_pool_stats["resident_videos"]),
                    )
                    exact_values.append(
                        _exact_digest(
                            resource_a.cache,
                            resource_a.frame_index,
                            resource_b.cache,
                            resource_b.frame_index,
                        )
                    )
            exact_digest = _json_digest(exact_values)
            pool_stats = pool.stats()
            # Report peak residency for comparability; the context has already
            # released both resources by the time the final resident count is
            # sampled.
            resident_videos = max(
                peak_pool_resident_videos,
                int(pool_stats["peak_resident_videos"]),
            )
            resident_bytes = max(
                peak_pool_resident_bytes,
                int(pool_stats["estimated_resident_bytes"]),
            )
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        after = process_memory_snapshot()
        before_peak = before.get("peak_rss_bytes") or before.get("current_rss_bytes") or 0
        after_peak = after.get("peak_rss_bytes") or after.get("current_rss_bytes") or 0
        summary_bytes = (
            sum(
                int(
                    summary.timestamps.nbytes
                    + summary.optimized_source_representatives.nbytes
                    + summary.optimized_index_embeddings.nbytes
                    + summary.auxiliary_signatures.nbytes
                )
                for summary in summaries.values()
            )
            if args.mode == "compact"
            else 0
        )
        modeled_peak_bytes = int(resident_bytes) + int(summary_bytes)
        rss_delta = max(0, int(after_peak) - int(before_peak))
        return {
            "mode": args.mode,
            "videos": args.videos,
            "frames_per_video": args.frames,
            "candidate_pair_digest": _json_digest(
                sorted(
                    tuple(sorted((Path(left).name, Path(right).name)))
                    for left, right in selection.pairs
                )
            ),
            "candidate_pair_count": len(selection.pairs),
            "exact_pair_count": len(_benchmark_pairs(video_paths)),
            "wall_elapsed_ms": round(elapsed_ms, 3),
            # RSS includes fixed interpreter/allocator/FAISS overhead and is
            # therefore diagnostic only.  The modeled value below is the
            # comparable artifact residency (embeddings, indexes, summaries).
            "rss_peak_delta_bytes": rss_delta,
            "resident_videos": resident_videos,
            "resident_estimated_bytes": resident_bytes,
            "compact_summary_bytes": summary_bytes,
            "modeled_peak_artifact_bytes": modeled_peak_bytes,
            "rss_vs_modeled_bytes": int(rss_delta - modeled_peak_bytes),
            "rss_unattributed_bytes": max(0, int(rss_delta - modeled_peak_bytes)),
            "auxiliary_estimate": estimate_auxiliary_memory_bytes(
                summaries if args.mode == "compact" else caches
            ),
            "pool": pool_stats,
            "exact_digest": exact_digest,
        }
    finally:
        if temporary is not None:
            temporary.cleanup()


def _validate_profile_result(profile_result: dict) -> None:
    """Validate correctness and the modeled residency gate for one profile.

    A worker's RSS is intentionally not used as the gate: interpreter startup,
    FAISS arenas, and allocator reuse are fixed costs that can exceed the
    actual cache footprint in the smoke profile.  ``modeled_peak_artifact``
    contains only the cache/index/summary bytes retained by the algorithm and
    is comparable between the legacy and compact paths.
    """

    legacy = profile_result["legacy"]
    compact = profile_result["compact"]
    config = profile_result["config"]
    if legacy["candidate_pair_digest"] != compact["candidate_pair_digest"]:
        raise RuntimeError("compact summary changed candidate pairs")
    if legacy["exact_digest"] != compact["exact_digest"]:
        raise RuntimeError("pool exact result/segments differ from legacy")
    if legacy["candidate_pair_count"] != compact["candidate_pair_count"]:
        raise RuntimeError("compact summary changed candidate pair count")
    if compact["pool"]["capacity"] != 2:
        raise RuntimeError("compact pool capacity must remain two resources")
    if compact["pool"]["peak_resident_videos"] != 2:
        raise RuntimeError("compact pool did not exercise two-resource residency")
    if compact["resident_videos"] != 2:
        raise RuntimeError("compact peak resident video count is not two")
    legacy_modeled = int(legacy["modeled_peak_artifact_bytes"])
    compact_modeled = int(compact["modeled_peak_artifact_bytes"])
    if legacy_modeled <= 0 or compact_modeled <= 0:
        raise RuntimeError("modeled artifact residency must be positive")
    modeled_reduction = 1.0 - compact_modeled / legacy_modeled
    if config.get("memory_gate", False) and modeled_reduction < 0.5:
        raise RuntimeError(
            "modeled artifact residency reduction below 50%: "
            f"{modeled_reduction:.3f} for {config}"
        )


def _validate_report_profiles(profile_results: dict[str, dict]) -> dict:
    """Validate cross-profile invariants and return machine-readable checks."""

    if not profile_results:
        raise RuntimeError("resource-pool benchmark produced no profiles")
    for profile_result in profile_results.values():
        if profile_result.get("status") != "ok":
            raise RuntimeError("resource-pool profile did not complete")
        _validate_profile_result(profile_result)

    checks = {
        "all_profiles_ok": True,
        "candidate_digest_match": all(
            profile["legacy"]["candidate_pair_digest"]
            == profile["compact"]["candidate_pair_digest"]
            for profile in profile_results.values()
        ),
        "exact_digest_match": all(
            profile["legacy"]["exact_digest"] == profile["compact"]["exact_digest"]
            for profile in profile_results.values()
        ),
        "compact_peak_resident_videos_two": all(
            profile["compact"]["resident_videos"] == 2
            and profile["compact"]["pool"]["peak_resident_videos"] == 2
            for profile in profile_results.values()
        ),
    }
    if "smoke" in profile_results and "scale" in profile_results:
        smoke = profile_results["smoke"]
        scale = profile_results["scale"]
        legacy_increases = (
            scale["legacy"]["modeled_peak_artifact_bytes"]
            > smoke["legacy"]["modeled_peak_artifact_bytes"]
        )
        compact_increases = (
            scale["compact"]["modeled_peak_artifact_bytes"]
            > smoke["compact"]["modeled_peak_artifact_bytes"]
        )
        if not legacy_increases or not compact_increases:
            raise RuntimeError(
                "modeled residency did not increase from smoke to scale: "
                f"legacy={legacy_increases}, compact={compact_increases}"
            )
        checks["smoke_to_scale_legacy_increases"] = legacy_increases
        checks["smoke_to_scale_compact_increases"] = compact_increases
    return checks


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--profile",
        choices=["smoke", "scale", "all"],
        default="all",
        help="run a small repeatable smoke profile, the scale profile, or both",
    )
    parser.add_argument("--videos", type=int, default=None)
    parser.add_argument("--frames", type=int, default=None)
    parser.add_argument("--dimension", type=int, default=None)
    parser.add_argument("--seed", type=int, default=20260815)
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--artifact-root", type=Path, default=None)
    parser.add_argument("--mode", choices=["legacy", "compact"], default=None)
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "data" / "benchmarks" / "resource_pool_stage4b.json",
    )
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(_run_worker(args), ensure_ascii=False))
        return
    explicit_dimensions = any(
        value is not None for value in (args.videos, args.frames, args.dimension)
    )
    if explicit_dimensions:
        fallback = PROFILE_CONFIGS["scale"]
        profile_specs = {
            "custom": {
                "videos": args.videos if args.videos is not None else fallback["videos"],
                "frames": args.frames if args.frames is not None else fallback["frames"],
                "dimension": (
                    args.dimension if args.dimension is not None else fallback["dimension"]
                ),
                "memory_gate": True,
            }
        }
    elif args.profile == "all":
        profile_specs = {name: dict(config) for name, config in PROFILE_CONFIGS.items()}
    else:
        profile_specs = {args.profile: dict(PROFILE_CONFIGS[args.profile])}

    if any(config["videos"] < 2 for config in profile_specs.values()):
        parser.error("每个基准档至少需要 2 个视频，以验证双资源驻留")

    result = {
        "mode": "resource_pool_stage4b",
        "status": "failed",
        "config": {
            "profile": args.profile,
            "profiles": profile_specs,
            "seed": args.seed,
            "output": str(args.output),
        },
        "environment": {"python": platform.python_version(), "platform": platform.platform()},
    }
    try:
        profile_results = {}
        for profile_name, config in profile_specs.items():
            with tempfile.TemporaryDirectory(
                prefix=f"video-sim-pool-bench-{profile_name}-"
            ) as temporary:
                artifact_root = Path(temporary)
                _prepare_artifacts(
                    artifact_root,
                    config["videos"],
                    config["frames"],
                    config["dimension"],
                    args.seed,
                )
                common = [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--videos", str(config["videos"]),
                    "--frames", str(config["frames"]),
                    "--dimension", str(config["dimension"]),
                    "--seed", str(args.seed),
                    "--artifact-root", str(artifact_root),
                    "--worker",
                ]

                def run_worker(mode: str) -> dict:
                    completed = subprocess.run(
                        common + ["--mode", mode],
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    if completed.returncode != 0:
                        raise RuntimeError(
                            f"{profile_name}/{mode} worker failed with exit code "
                            f"{completed.returncode}: "
                            f"{completed.stderr.strip() or completed.stdout.strip()}"
                        )
                    try:
                        return json.loads(completed.stdout)
                    except json.JSONDecodeError as exc:
                        raise RuntimeError(
                            f"{profile_name}/{mode} worker returned invalid JSON: "
                            f"{completed.stdout[-1000:]}"
                        ) from exc

                legacy = run_worker("legacy")
                compact = run_worker("compact")

            profile_result = {
                "status": "ok",
                "config": config,
                "legacy": legacy,
                "compact": compact,
            }
            _validate_profile_result(profile_result)
            legacy_rss = max(1, legacy["rss_peak_delta_bytes"])
            rss_reduction = max(
                0.0, 1.0 - compact["rss_peak_delta_bytes"] / legacy_rss
            )
            modeled_legacy = max(1, legacy["modeled_peak_artifact_bytes"])
            modeled_reduction = max(
                0.0,
                1.0
                - compact["modeled_peak_artifact_bytes"] / modeled_legacy,
            )
            profile_result.update(
                {
                    "peak_rss_reduction_ratio": round(rss_reduction, 4),
                    "modeled_peak_reduction_ratio": round(modeled_reduction, 4),
                }
            )
            profile_results[profile_name] = profile_result

        checks = _validate_report_profiles(profile_results)
        result.update(
            {
                "status": "ok",
                "profiles": profile_results,
                "checks": checks,
                "memory_trend": {
                    "measured": "modeled_peak_artifact_bytes",
                    "smoke_to_scale_legacy_increases": checks.get(
                        "smoke_to_scale_legacy_increases"
                    ),
                    "smoke_to_scale_compact_increases": checks.get(
                        "smoke_to_scale_compact_increases"
                    ),
                    "rss_is_diagnostic_only": True,
                },
                "memory_accounting": {
                    "primary_metric": "modeled_peak_artifact_bytes",
                    "primary_metric_includes": [
                        "retained frame embeddings",
                        "retained FAISS vector storage",
                        "compact candidate summaries",
                    ],
                    "rss_peak_delta_is_diagnostic": True,
                    "rss_overhead_field": "rss_vs_modeled_bytes",
                    "rss_overhead_note": (
                        "RSS also contains fixed interpreter, allocator and FAISS "
                        "startup/arena costs; it is not the memory gate."
                    ),
                },
            }
        )
    except Exception as exc:
        result["error"] = str(exc)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(result, indent=2, ensure_ascii=False))
        print(f"Benchmark JSON: {args.output}")
        raise
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"Benchmark JSON: {args.output}")


if __name__ == "__main__":
    main()
