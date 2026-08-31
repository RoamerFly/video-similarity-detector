#!/usr/bin/env python3
"""Exploratory benchmarks for recognition optimization round three.

This script measures three bounded, semantics-preserving paths:

* full feature-cache load plus candidate-summary construction versus a hot
  candidate-summary sidecar load;
* the finite-window pair scheduler's sequential LRU model on a deterministic
  large library; and
* the historical SQLite per-pair reconnect pattern versus the current
  single-owner ``ResumeSQLiteWriter``.

The measurements are deliberately exploratory.  They report every raw run
and medians, but do not claim an accuracy increase, a statistically verified
speedup, or an end-to-end memory reduction.  The operating system page cache
is not flushed; synthetic cache files are prepared before timing and ABBA
order is used for the timed operations.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import sqlite3
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable

import numpy as np


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DEFAULT_OUTPUT = ROOT / "data" / "upgrade_round3_20260831" / "benchmark_round3.json"
DEFAULT_CACHE_DIR = ROOT / "data" / "upgrade_round3_20260831" / "synthetic_cache"


def _json_default(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(f"value is not JSON serializable: {type(value).__name__}")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=_json_default)


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _git_source() -> dict[str, Any]:
    try:
        source_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        return {
            "sha": source_sha,
            "working_tree_dirty": bool(status.strip()),
        }
    except (OSError, subprocess.SubprocessError) as exc:
        return {"sha": None, "working_tree_dirty": None, "error": str(exc)}


def _median(rows: list[Mapping[str, Any]], field: str) -> float | None:
    values = [float(row[field]) for row in rows if row.get(field) is not None]
    return round(statistics.median(values), 3) if values else None


def _digest_parts(parts: list[bytes], *, version: bytes) -> str:
    digest = hashlib.sha256()
    digest.update(version)
    for part in parts:
        digest.update(len(part).to_bytes(8, "little"))
        digest.update(part)
    return digest.hexdigest()


def _summary_semantic_digest(summary: Any) -> str:
    """Hash every candidate-semantic array while excluding runtime telemetry."""

    fields: list[bytes] = []
    for name in (
        "video_path",
        "frame_count",
        "duration_seconds",
        "auxiliary_kind",
        "embedding_shape",
        "embedding_dtype",
    ):
        fields.append(str(getattr(summary, name, "")).encode("utf-8"))
    for name in (
        "timestamps",
        "optimized_source_representatives",
        "optimized_index_embeddings",
        "auxiliary_signatures",
        "baseline_source_representatives",
        "baseline_index_embeddings",
    ):
        value = getattr(summary, name, None)
        if value is None:
            fields.append(b"<none>")
            continue
        array = np.ascontiguousarray(np.asarray(value))
        fields.extend(
            (
                name.encode("ascii"),
                str(array.dtype).encode("ascii"),
                _canonical_json(list(array.shape)).encode("ascii"),
                array.tobytes(order="C"),
            )
        )
    return _digest_parts(fields, version=b"round3-summary-semantic-v1\0")


def _pairs_digest(pairs: list[tuple[Path, Path]]) -> str:
    rows = [[str(left), str(right)] for left, right in pairs]
    return _sha256_bytes(("round3-pairs-v1\0" + _canonical_json(rows)).encode("utf-8"))


def _cache_bytes(paths: Mapping[Path, Path]) -> int:
    total = 0
    for path in paths.values():
        try:
            total += int(path.stat().st_size)
        except OSError:
            pass
    return total


def _sidecar_bytes(paths: Mapping[Path, Path]) -> int:
    from video_sim.candidate_summary_store import candidate_summary_path

    total = 0
    for path in paths.values():
        try:
            total += int(candidate_summary_path(path).stat().st_size)
        except OSError:
            pass
    return total


def _build_synthetic_caches(
    root: Path,
    *,
    videos: int,
    frames: int,
    dimension: int,
    seed: int,
    skip_threshold: float,
    max_gap_sec: float,
) -> tuple[dict[Path, Path], dict[Path, dict[str, Any]]]:
    """Create deterministic valid frame caches and their metadata."""

    from video_sim.embedder import FrameEmbeddingCache
    from video_sim.preprocess import PreprocessConfig

    if videos < 2 or frames < 2 or dimension < 2:
        raise ValueError("videos >= 2, frames >= 2 and dimension >= 2 are required")
    rng = np.random.default_rng(int(seed))
    config = PreprocessConfig()
    cache_paths: dict[Path, Path] = {}
    metadata_by_video: dict[Path, dict[str, Any]] = {}
    for index in range(videos):
        video = root / "videos" / f"synthetic-{index:04d}.mp4"
        video.parent.mkdir(parents=True, exist_ok=True)
        # The video bytes are only used for the cache identity in this audit;
        # no decoder is involved.  Keeping the bytes deterministic also makes
        # this fixture safe to regenerate in a clean directory.
        video.write_bytes((f"round3 synthetic video {index}\n").encode("ascii"))
        raw = rng.normal(size=(frames, dimension)).astype("float32")
        norms = np.linalg.norm(raw, axis=1, keepdims=True)
        embeddings = raw / np.maximum(norms, np.finfo("float32").eps)
        timestamps = np.arange(frames, dtype="float64") * 0.4
        # Invalid pHash strings intentionally exercise the deterministic
        # simhash fallback used by both full and sidecar candidate paths.
        cache = FrameEmbeddingCache(
            video_path=str(video),
            frame_indices=np.arange(frames, dtype=np.int64),
            timestamps=timestamps,
            phashes=["synthetic"] * frames,
            thumbnail_paths=[],
            embeddings=np.ascontiguousarray(embeddings),
            preprocess_config=config,
            metadata=FrameEmbeddingCache.build_metadata(
                video,
                skip_threshold,
                max_gap_sec,
                1,
                config,
            ),
        )
        cache.metadata["duration_sec"] = float(timestamps[-1]) if len(timestamps) else 0.0
        cache_path = FrameEmbeddingCache.get_cache_path(
            video,
            root / "cache",
            config,
            skip_threshold=skip_threshold,
            max_gap_sec=max_gap_sec,
            frame_step=1,
        )
        cache.save(cache_path)
        cache_paths[video] = cache_path
        metadata_by_video[video] = dict(cache.metadata or {})
    return cache_paths, metadata_by_video


def _prepare_sidecars(
    cache_paths: Mapping[Path, Path],
    metadata_by_video: Mapping[Path, Mapping[str, Any]],
) -> None:
    from video_sim.candidate_selector import build_candidate_summary
    from video_sim.candidate_summary_store import candidate_summary_path, save_candidate_summary
    from video_sim.embedder import FrameEmbeddingCache

    for video, cache_path in cache_paths.items():
        cache = FrameEmbeddingCache.load(cache_path)
        summary = build_candidate_summary(
            cache,
            representatives_per_video=64,
            max_index_frames_per_video=1024,
            window_seconds=30.0,
            max_windows_per_video=96,
            include_baseline=False,
        )
        save_candidate_summary(
            summary,
            cache_path,
            cache_metadata=metadata_by_video[video],
            source_cache_path=cache_path,
        )
        if not candidate_summary_path(cache_path).is_file():
            raise RuntimeError(f"sidecar was not created: {cache_path}")


def _full_audit(
    cache_paths: Mapping[Path, Path],
    *,
    skip_threshold: float,
    max_gap_sec: float,
) -> tuple[dict[Path, Any], float, float]:
    from video_sim.candidate_selector import build_candidate_summary
    from video_sim.embedder import FrameEmbeddingCache
    from video_sim.preprocess import PreprocessConfig

    config = PreprocessConfig()
    started_wall = time.perf_counter()
    started_cpu = time.process_time()
    summaries: dict[Path, Any] = {}
    for video in cache_paths:
        cache = FrameEmbeddingCache.load_valid(
            video,
            cache_dir=cache_paths[video].parents[3] if len(cache_paths[video].parents) > 3 else cache_paths[video].parent,
            preprocess_config=config,
            skip_threshold=skip_threshold,
            max_gap_sec=max_gap_sec,
            frame_step=1,
        )
        if cache is None:
            raise RuntimeError(f"full cache audit could not load {video}")
        summaries[video] = build_candidate_summary(
            cache,
            representatives_per_video=64,
            max_index_frames_per_video=1024,
            window_seconds=30.0,
            max_windows_per_video=96,
            include_baseline=False,
        )
    return summaries, (time.perf_counter() - started_wall) * 1000.0, (time.process_time() - started_cpu) * 1000.0


def _hot_audit(
    cache_paths: Mapping[Path, Path],
    metadata_by_video: Mapping[Path, Mapping[str, Any]],
) -> tuple[dict[Path, Any], float, float]:
    from video_sim.candidate_summary_store import candidate_summary_path, load_candidate_summary
    from video_sim.recognition_contract import artifact_identity

    started_wall = time.perf_counter()
    started_cpu = time.process_time()
    summaries: dict[Path, Any] = {}
    for video, cache_path in cache_paths.items():
        sidecar = candidate_summary_path(cache_path)
        summaries[video] = load_candidate_summary(
            sidecar,
            expected_cache_metadata=metadata_by_video[video],
            source_cache_path=cache_path,
            source_artifact_identity=artifact_identity(cache_path),
        )
    return summaries, (time.perf_counter() - started_wall) * 1000.0, (time.process_time() - started_cpu) * 1000.0


def _candidate_pairs(
    values: Mapping[Path, Any],
    *,
    candidate_limit: int,
) -> list[tuple[Path, Path]]:
    from video_sim.candidate_selector import select_candidate_pairs

    return select_candidate_pairs(
        values,
        candidate_limit=candidate_limit,
        match_threshold=0.8,
        representatives_per_video=64,
        max_index_frames_per_video=1024,
        window_seconds=30.0,
        max_windows_per_video=96,
        sketch_mode="optimized",
    ).pairs


def _benchmark_summary_audit(args: argparse.Namespace) -> dict[str, Any]:
    cache_root = args.cache_dir.resolve()
    cache_paths, metadata_by_video = _build_synthetic_caches(
        cache_root,
        videos=args.videos,
        frames=args.frames,
        dimension=args.dimension,
        seed=args.seed,
        skip_threshold=args.skip_threshold,
        max_gap_sec=args.max_gap_sec,
    )
    _prepare_sidecars(cache_paths, metadata_by_video)

    # One warmup operation per mode makes import/allocation effects less likely
    # to dominate.  The timed sequence is ABBA for each requested repeat.
    for _ in range(args.warmup):
        for mode in ("full", "hot"):
            if mode == "full":
                _full_audit(cache_paths, skip_threshold=args.skip_threshold, max_gap_sec=args.max_gap_sec)
            else:
                _hot_audit(cache_paths, metadata_by_video)
            gc.collect()

    raw: list[dict[str, Any]] = []
    mode_sequence: list[str] = []
    for _ in range(args.repeats):
        mode_sequence.extend(("full", "hot", "hot", "full"))
    latest: dict[str, dict[Path, Any]] = {}
    for run_index, mode in enumerate(mode_sequence, start=1):
        if mode == "full":
            values, wall_ms, cpu_ms = _full_audit(
                cache_paths,
                skip_threshold=args.skip_threshold,
                max_gap_sec=args.max_gap_sec,
            )
        else:
            values, wall_ms, cpu_ms = _hot_audit(cache_paths, metadata_by_video)
        latest[mode] = values
        raw.append(
            {
                "run": run_index,
                "mode": mode,
                "wall_ms": round(wall_ms, 3),
                "cpu_ms": round(cpu_ms, 3),
                "summary_semantic_digest": _sha256_bytes(
                    _canonical_json(
                        {str(video): _summary_semantic_digest(summary) for video, summary in values.items()}
                    ).encode("utf-8")
                ),
                "cache_bytes": _cache_bytes(cache_paths),
                "sidecar_bytes": _sidecar_bytes(cache_paths),
                "timing_semantics": "full=load_valid+build_candidate_summary; hot=load_candidate_summary only",
            }
        )

    full_values = latest["full"]
    hot_values = latest["hot"]
    full_summary_digests = {str(video): _summary_semantic_digest(summary) for video, summary in full_values.items()}
    hot_summary_digests = {str(video): _summary_semantic_digest(summary) for video, summary in hot_values.items()}
    full_pairs = _candidate_pairs(full_values, candidate_limit=args.candidate_limit)
    hot_pairs = _candidate_pairs(hot_values, candidate_limit=args.candidate_limit)
    semantic_equal = full_summary_digests == hot_summary_digests
    pair_equal = full_pairs == hot_pairs
    medians = {
        mode: {
            "wall_ms": _median([row for row in raw if row["mode"] == mode], "wall_ms"),
            "cpu_ms": _median([row for row in raw if row["mode"] == mode], "cpu_ms"),
        }
        for mode in ("full", "hot")
    }
    return {
        "parameters": {
            "videos": args.videos,
            "frames": args.frames,
            "dimension": args.dimension,
            "seed": args.seed,
            "candidate_limit": args.candidate_limit,
            "skip_threshold": args.skip_threshold,
            "max_gap_sec": args.max_gap_sec,
            "warmup": args.warmup,
            "repeats": args.repeats,
            "order": "ABBA per repeat: full, hot, hot, full",
        },
        "raw": raw,
        "median": medians,
        "correctness": {
            "status": "pass" if semantic_equal and pair_equal else "fail",
            "summary_semantics_equal": semantic_equal,
            "candidate_pairs_equal": pair_equal,
            "full_candidate_pairs_digest": _pairs_digest(full_pairs),
            "hot_candidate_pairs_digest": _pairs_digest(hot_pairs),
            "full_candidate_pair_count": len(full_pairs),
            "hot_candidate_pair_count": len(hot_pairs),
            "per_video_summary_digests_equal": semantic_equal,
        },
        "storage": {
            "cache_bytes": _cache_bytes(cache_paths),
            "sidecar_bytes": _sidecar_bytes(cache_paths),
            "sidecar_path": "candidate_summary.npz next to each frame_features.npz",
        },
        "limitations": [
            "Synthetic embeddings and cache files; no decoder or CLIP inference is measured.",
            "OS page cache is not flushed; the result is a warm-file-system comparison.",
            "Summary sidecars retain full timestamps and auxiliary signatures, so overall sidecar storage remains O(N); only embedding sketches are bounded.",
            "Candidate equality proves semantic preservation of the candidate stage, not improved overall recognition precision.",
        ],
    }


def _scheduler_items(count: int, *, cluster_size: int = 16) -> list[Any]:
    from video_sim.pair_scheduler import PairWorkItem

    if count < 4 or count % 4:
        raise ValueError("scheduler pair count must be a positive multiple of four")
    clusters = math.ceil(count / 4)
    items: list[Any] = []
    ordinal = 0
    # Each block contains four edges per cluster, but the input interleaves
    # those edges by cluster.  A bounded window can group the shared endpoints
    # inside each block without changing the report contract.
    for block_start in range(0, clusters, cluster_size):
        block_stop = min(clusters, block_start + cluster_size)
        cluster_ids = range(block_start, block_stop)
        for edge_index in range(4):
            for cluster in cluster_ids:
                root = Path(f"synthetic-library/cluster-{cluster:05d}")
                points = [root / f"video-{point}.mp4" for point in range(4)]
                edge = ((0, 1), (2, 3), (0, 2), (1, 3))[edge_index]
                items.append(
                    PairWorkItem(
                        report_ordinal=ordinal,
                        video_a=points[edge[0]],
                        video_b=points[edge[1]],
                        key=f"pair-{ordinal:06d}",
                        units=1.0 + (ordinal % 7) / 10.0,
                    )
                )
                ordinal += 1
    return items[:count]


def _benchmark_scheduler(args: argparse.Namespace) -> dict[str, Any]:
    from video_sim.pair_scheduler import schedule_diagnostics, schedule_pairs_for_locality

    items = _scheduler_items(args.scheduler_pairs)
    started = time.perf_counter()
    scheduled = schedule_pairs_for_locality(
        items,
        window_size=args.schedule_window,
        resident_capacity=args.resident_capacity,
    )
    wall_ms = (time.perf_counter() - started) * 1000.0
    original_diagnostics = schedule_diagnostics(items, items, args.resident_capacity)
    scheduled_diagnostics = schedule_diagnostics(items, scheduled, args.resident_capacity)
    original_contract = [
        (item.report_ordinal, str(item.video_a), str(item.video_b), item.key, item.units)
        for item in items
    ]
    scheduled_contract = sorted(
        (item.report_ordinal, str(item.video_a), str(item.video_b), item.key, item.units)
        for item in scheduled
    )
    result_payloads = {
        item.report_ordinal: {
            "key": item.key,
            "result": f"result-{item.report_ordinal:06d}",
        }
        for item in items
    }
    scheduled_result_digest = _sha256_bytes(
        _canonical_json([result_payloads[item.report_ordinal] for item in sorted(scheduled, key=lambda row: row.report_ordinal)]).encode("utf-8")
    )
    original_result_digest = _sha256_bytes(
        _canonical_json([result_payloads[item.report_ordinal] for item in items]).encode("utf-8")
    )
    correctness = {
        "status": "pass" if original_contract == scheduled_contract and original_result_digest == scheduled_result_digest else "fail",
        "pair_count_equal": len(items) == len(scheduled),
        "object_identity_preserved": {id(item) for item in items} == {id(item) for item in scheduled},
        "direction_and_ordinal_preserved": original_contract == scheduled_contract,
        "result_digest_equal": original_result_digest == scheduled_result_digest,
        "original_result_digest": original_result_digest,
        "scheduled_result_digest": scheduled_result_digest,
    }
    return {
        "parameters": {
            "pairs": args.scheduler_pairs,
            "window_size": args.schedule_window,
            "resident_capacity": args.resident_capacity,
            "cluster_shape": "four edges per four-video cluster, deterministic finite blocks",
        },
        "raw": [{"run": 1, "wall_ms": round(wall_ms, 3)}],
        "median": {"wall_ms": round(wall_ms, 3)},
        "correctness": correctness,
        "original": original_diagnostics,
        "scheduled": scheduled_diagnostics,
        "limitations": [
            "Hits, misses and evictions are sequential predicted LRU counters; they do not describe concurrent resource-pool timing.",
            "Only execution order changes; the report order, pair direction and ordinal remain unchanged.",
        ],
    }


def _payload(index: int) -> dict[str, Any]:
    return {
        "report_schema_version": 2,
        "containment_scoring_version": 5,
        "report_ordinal": index,
        "video_a": f"synthetic-a-{index:04d}.mp4",
        "video_b": f"synthetic-b-{index:04d}.mp4",
        "score": round((index % 97) / 97.0, 8),
    }


def _payload_digest(rows: Mapping[str, Any]) -> str:
    ordered = [[key, rows[key]] for key in sorted(rows)]
    return _sha256_bytes(("round3-sqlite-payload-v1\0" + _canonical_json(ordered)).encode("utf-8"))


def _prior_sqlite_pattern(database: Path, rows: int) -> dict[str, Any]:
    started = time.perf_counter()
    connections = 0
    commits = 0
    for index in range(rows):
        connection = sqlite3.connect(database, timeout=30)
        connections += 1
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS completed_pairs (pair_key TEXT PRIMARY KEY, pair_json TEXT NOT NULL)"
            )
            pair_key = f"pair-{index:06d}"
            pair_json = json.dumps(_payload(index), ensure_ascii=False, separators=(",", ":"))
            connection.execute(
                "INSERT INTO completed_pairs(pair_key, pair_json) VALUES(?, ?) "
                "ON CONFLICT(pair_key) DO UPDATE SET pair_json=excluded.pair_json",
                (pair_key, pair_json),
            )
            connection.commit()
            commits += 1
        finally:
            connection.close()
    from video_sim.resume_store import load_resume_pairs

    diagnostics: dict[str, int] = {}
    loaded = load_resume_pairs(database, batch_size=256, diagnostics=diagnostics)
    return {
        "wall_ms": (time.perf_counter() - started) * 1000.0,
        "connections": connections,
        "commits": commits,
        "rows": len(loaded),
        "read_batches": diagnostics.get("read_batches", 0),
        "read_rows": diagnostics.get("read_rows", 0),
        "payload_digest": _payload_digest(loaded),
    }


def _current_sqlite_pattern(database: Path, rows: int) -> dict[str, Any]:
    from video_sim.resume_store import ResumeSQLiteWriter, load_resume_pairs

    started = time.perf_counter()
    writer = ResumeSQLiteWriter(database)
    try:
        for index in range(rows):
            writer.write_pair(f"pair-{index:06d}", _payload(index))
        writer_diagnostics = writer.diagnostics()
    finally:
        writer.close()
    diagnostics: dict[str, int] = {}
    loaded = load_resume_pairs(database, batch_size=256, diagnostics=diagnostics)
    return {
        "wall_ms": (time.perf_counter() - started) * 1000.0,
        "connections": writer_diagnostics.get("connection_inits", 0),
        "commits": writer_diagnostics.get("writer_commits", 0),
        "rows": len(loaded),
        "read_batches": diagnostics.get("read_batches", 0),
        "read_rows": diagnostics.get("read_rows", 0),
        "payload_digest": _payload_digest(loaded),
        "writer_retries": writer_diagnostics.get("writer_retries", 0),
    }


def _benchmark_sqlite(args: argparse.Namespace) -> dict[str, Any]:
    raw: list[dict[str, Any]] = []
    for _ in range(args.repeats):
        for mode in ("prior", "current", "current", "prior"):
            with tempfile.TemporaryDirectory(prefix="round3-sqlite-") as temporary:
                database = Path(temporary) / "resume.sqlite3"
                value = (
                    _prior_sqlite_pattern(database, args.sqlite_rows)
                    if mode == "prior"
                    else _current_sqlite_pattern(database, args.sqlite_rows)
                )
                raw.append({"run": len(raw) + 1, "mode": mode, **value})
    medians = {
        mode: {"wall_ms": _median([row for row in raw if row["mode"] == mode], "wall_ms")}
        for mode in ("prior", "current")
    }
    prior = [row for row in raw if row["mode"] == "prior"]
    current = [row for row in raw if row["mode"] == "current"]
    same_payload = bool(prior and current) and all(
        row["payload_digest"] == prior[0]["payload_digest"] for row in prior + current
    )
    same_rows = bool(prior and current) and all(row["rows"] == args.sqlite_rows for row in prior + current)
    same_commits = bool(prior and current) and all(row["commits"] == args.sqlite_rows for row in prior + current)
    current_connections_one = bool(current) and all(row["connections"] == 1 for row in current)
    prior_connections_rows = bool(prior) and all(row["connections"] == args.sqlite_rows for row in prior)
    expected_batches = math.ceil(args.sqlite_rows / 256)
    same_batches = bool(prior and current) and all(row["read_batches"] == expected_batches for row in prior + current)
    return {
        "parameters": {
            "rows": args.sqlite_rows,
            "read_batch_size": 256,
            "warmup": "none; each timed mode uses an isolated temporary database",
            "repeats": args.repeats,
            "order": "ABBA per repeat: prior, current, current, prior",
        },
        "raw": raw,
        "median": medians,
        "correctness": {
            "status": "pass" if same_payload and same_rows and same_commits and same_batches else "fail",
            "payload_digest_equal": same_payload,
            "rows_equal": same_rows,
            "commits_equal": same_commits,
            "fetchmany_batches_equal": same_batches,
            "expected_fetchmany_batches": expected_batches,
            "prior_connections_equal_rows": prior_connections_rows,
            "current_connections_equal_one": current_connections_one,
        },
        "limitations": [
            "The prior path is an in-process simulation of reconnect+PRAGMA/DDL+commit for each row, not a historical timing trace.",
            "SQLite timings use temporary local storage and cannot be extrapolated to end-to-end comparison duration.",
            "Both paths still commit each pair to preserve the existing crash boundary; only connection/setup work is amortized.",
        ],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--videos", type=int, default=8)
    parser.add_argument("--frames", type=int, default=128)
    parser.add_argument("--dimension", type=int, default=32)
    parser.add_argument("--candidate-limit", type=int, default=3)
    parser.add_argument("--seed", type=int, default=20260831)
    parser.add_argument("--skip-threshold", type=float, default=0.9)
    parser.add_argument("--max-gap-sec", type=float, default=5.0)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--scheduler-pairs", type=int, default=1000)
    parser.add_argument("--schedule-window", type=int, default=64)
    parser.add_argument("--resident-capacity", type=int, default=2)
    parser.add_argument("--sqlite-rows", type=int, default=1000)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.videos < 2 or args.frames < 2 or args.dimension < 2:
        raise SystemExit("--videos, --frames and --dimension must be at least 2")
    if args.repeats < 1 or args.warmup < 0:
        raise SystemExit("--repeats must be positive and --warmup cannot be negative")
    if args.scheduler_pairs < 4 or args.scheduler_pairs % 4:
        raise SystemExit("--scheduler-pairs must be a positive multiple of four")
    if args.sqlite_rows < 1:
        raise SystemExit("--sqlite-rows must be positive")

    report = {
        "schema_version": "round3-benchmark-v1",
        "status": "ok",
        "source": _git_source(),
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "numpy": np.__version__,
            "cwd": str(ROOT),
        },
        "summary_audit": _benchmark_summary_audit(args),
        "scheduler": _benchmark_scheduler(args),
        "sqlite": _benchmark_sqlite(args),
        "limitations": [
            "All reported medians are exploratory local measurements; raw runs are retained for inspection.",
            "No CUDA path was measured.",
            "Final JSON/CSV/HTML report rows remain materialized by the production reporter.",
        ],
    }
    correctness = [
        report["summary_audit"]["correctness"]["status"],
        report["scheduler"]["correctness"]["status"],
        report["sqlite"]["correctness"]["status"],
    ]
    if any(status != "pass" for status in correctness):
        report["status"] = "failed_correctness"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=_json_default) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False, default=_json_default))
    print(f"Benchmark JSON: {args.output}")
    return 0 if report["status"] == "ok" else 2


if __name__ == "__main__":
    raise SystemExit(main())
