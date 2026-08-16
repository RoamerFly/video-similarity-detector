#!/usr/bin/env python3
"""Real CLIP end-to-end regression benchmark.

The fixture videos are generated locally with ffmpeg.  No model or media is
downloaded by this script: callers should point ``VIDEO_SIM_CLIP_MODEL_DIR``
at an existing local CLIP checkpoint (``--model-dir`` does that for workers).

The default command is an orchestrator.  It creates deterministic fixtures,
runs independent CPU/CUDA workers, validates their cache and result parity,
and finally runs ``batch_compare.py`` against the same CPU cache directory.
Use ``--worker`` to run one device in isolation.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

import numpy as np


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
DEFAULT_MODEL_DIR = Path(
    r"D:\Desktop\工具\AAA打包工具\models\clip-vit-base-patch32"
)
DEFAULT_FFMPEG = Path(
    r"E:\Shell\FFmpeg\ffmpeg-master-latest-win64-gpl-shared\bin\ffmpeg.exe"
)
FIXTURE_NAMES = (
    "base",
    "exact_clip",
    "transformed_clip",
    "speed_clip",
    "short_clip",
    "unrelated",
)
KNOWN_TRIM_START = 3.0
KNOWN_TRIM_END = 6.0
# Fixture-specific sampling keeps enough temporal anchors for the short clips
# without making this local regression unnecessarily expensive.  It does not
# change production defaults.
SAMPLER_SKIP_THRESHOLD = 0.90
SAMPLER_MAX_GAP_SEC = 0.5
# The fixture deliberately contains large, semantically simple colour fields.
# Use a strict benchmark threshold so a visually similar but non-identical
# colour is not treated as an exact frame.  This is passed explicitly to the
# matcher and does not alter the production default.
E2E_MATCH_THRESHOLD = 0.95


def _diag(message: str) -> None:
    """Write an unbuffered worker diagnostic without contaminating JSON stdout."""

    print(f"[e2e] {message}", file=sys.stderr, flush=True)


def _find_ffmpeg(explicit: str | None = None) -> str:
    candidates = [explicit, os.environ.get("VIDEO_SIM_FFMPEG"), shutil.which("ffmpeg")]
    if DEFAULT_FFMPEG.exists():
        candidates.append(str(DEFAULT_FFMPEG))
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(candidate)
    raise RuntimeError("ffmpeg was not found; pass --ffmpeg or set VIDEO_SIM_FFMPEG")


def _resolve_python(explicit: str | Path | None = None) -> str:
    """Resolve the interpreter used for worker and batch subprocesses.

    The repository workspace may intentionally be a light development
    environment without the packaged runtime dependencies (notably decord).
    Keeping this choice explicit makes a real benchmark reproducible and
    produces a useful error instead of silently running under the wrong
    interpreter.  ``VIDEO_SIM_PYTHON`` is an equivalent non-interactive
    configuration for CI.
    """

    candidate = explicit or os.environ.get("VIDEO_SIM_PYTHON") or sys.executable
    path = Path(candidate).expanduser()
    if not path.exists() or not path.is_file():
        raise RuntimeError(
            f"Python runtime was not found: {path}. "
            "Pass --python <runtime-python.exe> or set VIDEO_SIM_PYTHON."
        )
    return str(path.resolve())


def _run_ffmpeg(ffmpeg: str, arguments: list[str], label: str) -> None:
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *arguments]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"ffmpeg failed while creating {label}: {detail}")


def _ensure_fixtures(root: Path, ffmpeg: str, force: bool = False) -> dict[str, Path]:
    """Create a 12-second base and deterministic derived clips."""

    root.mkdir(parents=True, exist_ok=True)
    paths = {name: root / f"{name}.mp4" for name in FIXTURE_NAMES}
    if not force and all(path.exists() and path.stat().st_size > 0 for path in paths.values()):
        return paths

    base = paths["base"]
    _run_ffmpeg(
        ffmpeg,
        [
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=320x180:r=4:d=3",
            "-f",
            "lavfi",
            "-i",
            "color=c=green:s=320x180:r=4:d=3",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=320x180:r=4:d=3",
            "-f",
            "lavfi",
            "-i",
            "color=c=purple:s=320x180:r=4:d=3",
            "-filter_complex",
            (
                "[0:v]drawbox=x='20+70*t':y=55:w=60:h=60:color=yellow:t=fill[v0];"
                "[1:v]drawbox=x=130:y='20+45*t':w=60:h=60:color=white:t=fill[v1];"
                "[2:v]drawbox=x='20+45*t':y='20+30*t':w=60:h=60:color=orange:t=fill[v2];"
                "[3:v]drawbox=x='180-35*t':y='35+25*t':w=60:h=60:color=cyan:t=fill[v3];"
                "[v0][v1][v2][v3]concat=n=4:v=1:a=0,format=yuv420p[v]"
            ),
            "-map",
            "[v]",
            "-r",
            "4",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            str(base),
        ],
        "base fixture",
    )

    _run_ffmpeg(
        ffmpeg,
        [
            "-i",
            str(base),
            "-ss",
            str(KNOWN_TRIM_START),
            "-t",
            str(KNOWN_TRIM_END - KNOWN_TRIM_START),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            str(paths["exact_clip"]),
        ],
        "exact clip fixture",
    )
    _run_ffmpeg(
        ffmpeg,
        [
            "-i",
            str(base),
            "-ss",
            str(KNOWN_TRIM_START),
            "-t",
            str(KNOWN_TRIM_END - KNOWN_TRIM_START),
            "-vf",
            "scale=256:144,eq=brightness=0.03:saturation=1.05",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "22",
            "-pix_fmt",
            "yuv420p",
            str(paths["transformed_clip"]),
        ],
        "transformed clip fixture",
    )
    _run_ffmpeg(
        ffmpeg,
        [
            "-i",
            str(base),
            "-ss",
            str(KNOWN_TRIM_START),
            "-t",
            str(KNOWN_TRIM_END - KNOWN_TRIM_START),
            "-vf",
            "setpts=PTS/1.05",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            str(paths["speed_clip"]),
        ],
        "speed clip fixture",
    )
    _run_ffmpeg(
        ffmpeg,
        [
            "-i",
            str(base),
            "-ss",
            str(KNOWN_TRIM_START),
            "-t",
            "1.25",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            str(paths["short_clip"]),
        ],
        "short clip fixture",
    )
    _run_ffmpeg(
        ffmpeg,
        [
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=4:duration=12",
            "-vf",
            "hue=s=0,negate,drawgrid=w=32:h=32:t=2:c=white",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            str(paths["unrelated"]),
        ],
        "unrelated fixture",
    )
    return paths


def _snapshot_delta(before: dict[str, int], after: dict[str, int], key: str) -> int:
    return max(0, int(after.get(key, 0) or 0) - int(before.get(key, 0) or 0))


def _duration(cache) -> float:
    metadata = cache.metadata or {}
    try:
        value = float(metadata.get("duration_sec", 0.0) or 0.0)
        if value > 0:
            return value
    except (TypeError, ValueError):
        pass
    return float(cache.timestamps[-1]) if len(cache.timestamps) else 0.0


def _segment_summary(segments: list[Any]) -> list[dict[str, float | int]]:
    return [
        {
            "source_start": float(segment.source_start),
            "source_end": float(segment.source_end),
            "target_start": float(segment.target_start),
            "target_end": float(segment.target_end),
            "coverage": float(segment.coverage),
            "confidence": float(segment.confidence),
            "match_count": int(segment.match_count),
        }
        for segment in segments
    ]


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    a = np.asarray(a, dtype="float32").reshape(-1)
    b = np.asarray(b, dtype="float32").reshape(-1)
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / denominator) if denominator else 0.0


def _run_worker(args: argparse.Namespace) -> dict[str, Any]:
    _diag(f"start worker device={args.device}")
    model_dir = Path(args.model_dir).expanduser()
    if not model_dir.is_dir():
        return {
            "status": "skipped",
            "device": str(args.device).lower(),
            "skip_reason": (
                f"CLIP model directory was not found: {model_dir}; "
                "pass --model-dir to an existing local checkpoint (no download is attempted)"
            ),
        }
    os.environ["VIDEO_SIM_CLIP_MODEL_DIR"] = str(Path(args.model_dir).resolve())
    os.environ["VIDEO_SIM_CLIP_AUTOCAST"] = "0"
    os.environ["VIDEO_SIM_STREAMING_PIPELINE"] = "1"
    os.environ["VIDEO_SIM_STREAMING_QUEUE_SIZE"] = str(args.queue_size)
    os.environ.setdefault("TORCH_NUM_THREADS", "2")

    _diag("import start")
    try:
        from video_sim.candidate_selector import select_candidate_pairs
        from video_sim.embedder import (
            FrameEmbeddingCache,
            VideoEmbedder,
            _embedding_batch_size,
            embedding_runtime_fingerprint,
            embed_frames_with_cache,
        )
        from video_sim.frame_sampler import DynamicFrameSampler
        from video_sim.indexer import build_frame_index
        from video_sim.matcher import compare_frame_indexes_bidirectional
        from video_sim.metrics import RecognitionMetrics, process_memory_snapshot
        from video_sim.segmenter import aggregate_bidirectional_segments
        import torch
    except ModuleNotFoundError as error:
        if error.name == "decord":
            raise RuntimeError(
                "The selected Python runtime is missing decord. "
                "Use --python <packaged-runtime-python.exe> or set VIDEO_SIM_PYTHON; "
                "no dependency download is attempted."
            ) from error
        raise
    _diag("import done")

    device = str(args.device).lower()
    if device == "cuda" and not torch.cuda.is_available():
        return {
            "status": "skipped",
            "skip_reason": "CUDA is unavailable in this runtime",
            "device": device,
        }
    model_before = process_memory_snapshot()
    model_started = time.perf_counter()
    _diag(f"model_init start device={device} model={args.model_dir}")
    embedder = VideoEmbedder(device=device, autocast_enabled=False)
    model_elapsed_ms = (time.perf_counter() - model_started) * 1000.0
    model_after = process_memory_snapshot()
    _diag(f"model_loaded elapsed_ms={model_elapsed_ms:.1f}")
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    fixture_root = Path(args.fixtures)
    cache_root = Path(args.cache_dir)
    cache_root.mkdir(parents=True, exist_ok=True)
    fixture_paths = {name: fixture_root / f"{name}.mp4" for name in FIXTURE_NAMES}
    _diag(f"fixture start root={fixture_root}")
    first_runs: dict[str, dict[str, Any]] = {}
    caches: dict[Path, FrameEmbeddingCache] = {}
    probes: dict[str, list[list[float]]] = {}
    batch_size = _embedding_batch_size(device, None)

    for name in FIXTURE_NAMES:
        video_path = fixture_paths[name]
        _diag(f"cache start name={name} path={video_path}")
        metrics = RecognitionMetrics()
        embedder.metrics = metrics
        sampler = DynamicFrameSampler(
            skip_threshold=SAMPLER_SKIP_THRESHOLD,
            max_gap_sec=SAMPLER_MAX_GAP_SEC,
            frame_step=1,
            cache_dir=cache_root,
            metrics=metrics,
        )
        started = time.perf_counter()
        cache = embed_frames_with_cache(
            video_path=video_path,
            retained_frames=None,
            sampler=sampler,
            embedder=embedder,
            cache_dir=cache_root,
            device=device,
            force=True,
            skip_threshold=SAMPLER_SKIP_THRESHOLD,
            max_gap_sec=SAMPLER_MAX_GAP_SEC,
            frame_step=1,
            embedding_runtime=embedding_runtime_fingerprint(device, autocast_enabled=False),
        )
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        cache_path = FrameEmbeddingCache.get_cache_path(
            video_path,
            cache_root,
            skip_threshold=SAMPLER_SKIP_THRESHOLD,
            max_gap_sec=SAMPLER_MAX_GAP_SEC,
            frame_step=1,
        )
        if not cache_path.exists():
            raise RuntimeError(f"cache was not written for {name}: {cache_path}")
        cache_metrics = RecognitionMetrics()
        embedder.metrics = cache_metrics
        cache_started = time.perf_counter()
        cache_hit = embed_frames_with_cache(
            video_path=video_path,
            retained_frames=None,
            sampler=None,
            embedder=embedder,
            cache_dir=cache_root,
            device=device,
            force=False,
            skip_threshold=SAMPLER_SKIP_THRESHOLD,
            max_gap_sec=SAMPLER_MAX_GAP_SEC,
            frame_step=1,
            embedding_runtime=embedding_runtime_fingerprint(device, autocast_enabled=False),
        )
        cache_hit_elapsed_ms = (time.perf_counter() - cache_started) * 1000.0
        if not np.array_equal(cache.embeddings, cache_hit.embeddings):
            raise AssertionError(f"cache hit changed embeddings for {name}")
        if cache_metrics.counters.get("frames_sampled", 0) or cache_metrics.counters.get("streaming_batches", 0):
            raise AssertionError(f"cache hit unexpectedly sampled/embedded {name}")
        caches[video_path] = cache
        probes[name] = np.asarray(cache.embeddings[:2], dtype="float32").tolist()
        counters = dict(metrics.counters)
        queue_limit = max(1, min(4, int(args.queue_size))) * max(1, batch_size)
        if device == "cuda" and counters.get("queue_peak_frames", 0) > queue_limit:
            raise AssertionError(
                f"GPU streaming queue exceeded bound for {name}: "
                f"{counters.get('queue_peak_frames')} > {queue_limit}"
            )
        first_runs[name] = {
            "wall_elapsed_ms": round(elapsed_ms, 3),
            "retained_frames": len(cache.embeddings),
            "duration_seconds": _duration(cache),
            "cache_bytes": cache_path.stat().st_size,
            "metrics": metrics.to_dict(),
            "cache_hit": True,
            "cache_hit_elapsed_ms": round(cache_hit_elapsed_ms, 3),
            "queue_capacity_frames": queue_limit if device == "cuda" else None,
        }
        _diag(f"cache done name={name} frames={len(cache.embeddings)} elapsed_ms={elapsed_ms:.1f}")

    _diag("compare start")
    indexes = {path: build_frame_index(cache) for path, cache in caches.items()}
    candidate_metrics = RecognitionMetrics()
    with candidate_metrics.stage("candidate", items=len(caches)):
        candidate_selection = select_candidate_pairs(
            caches,
            candidate_limit=0,
            match_threshold=E2E_MATCH_THRESHOLD,
        )
    candidate_pairs = sorted(
        sorted((Path(left).stem, Path(right).stem))
        for left, right in candidate_selection.pairs
    )

    pair_by_name = {name: path for name, path in ((path.stem, path) for path in caches)}
    requested_pairs = [
        ("base", "exact_clip"),
        ("base", "transformed_clip"),
        ("base", "speed_clip"),
        ("base", "short_clip"),
        ("base", "unrelated"),
    ]
    comparisons: dict[str, dict[str, Any]] = {}
    for left_name, right_name in requested_pairs:
        left_path = pair_by_name[left_name]
        right_path = pair_by_name[right_name]
        left_cache = caches[left_path]
        right_cache = caches[right_path]
        started = time.perf_counter()
        with candidate_metrics.stage(
            "exact_compare", items=len(left_cache.embeddings) + len(right_cache.embeddings)
        ):
            result = compare_frame_indexes_bidirectional(
                cache_a=left_cache,
                cache_b=right_cache,
                index_a=indexes[left_path],
                index_b=indexes[right_path],
                match_threshold=E2E_MATCH_THRESHOLD,
                top_k=1,
                early_stop=False,
            )
        with candidate_metrics.stage("segment", items=len(result.matches_a_to_b) + len(result.matches_b_to_a)):
            segments = aggregate_bidirectional_segments(
                result.matches_a_to_b,
                result.matches_b_to_a,
                source_timestamps_a=left_cache.timestamps,
                source_timestamps_b=right_cache.timestamps,
                total_source_duration_a=_duration(left_cache),
                total_source_duration_b=_duration(right_cache),
                min_segment_duration=0.75,
                min_segment_matches=2,
                offset_tolerance_sec=3.0,
            )
        key = f"{left_name}__{right_name}"
        comparisons[key] = {
            "relation": result.relation,
            "a_in_b": float(result.a_in_b),
            "b_in_a": float(result.b_in_a),
            "symmetric_similarity": float(result.symmetric_similarity),
            "raw_similarity_mean": float(result.raw_similarity_mean),
            "raw_similarity_p95": float(result.raw_similarity_p95),
            "matched_a_to_b": len(result.matches_a_to_b),
            "matched_b_to_a": len(result.matches_b_to_a),
            "segments": _segment_summary(segments),
            "wall_elapsed_ms": round((time.perf_counter() - started) * 1000.0, 3),
        }
        _diag(f"compare done pair={key} relation={result.relation} elapsed_ms={comparisons[key]['wall_elapsed_ms']}")

    analysis_metrics = candidate_metrics.to_dict()
    return {
        "status": "ok",
        "device": device,
        "runtime": {
            "python": sys.executable,
            "torch": torch.__version__,
            "cuda_available": bool(torch.cuda.is_available()),
            "cuda_device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            "platform": platform.platform(),
        },
        "model": {
            "path": str(Path(args.model_dir).resolve()),
            "precision": embedder.embedding_runtime_fingerprint(),
            "load_wall_elapsed_ms": round(model_elapsed_ms, 3),
            "load_rss_delta_bytes": _snapshot_delta(model_before, model_after, "peak_rss_bytes"),
            "load_current_rss_delta_bytes": _snapshot_delta(model_before, model_after, "current_rss_bytes"),
        },
        "fixtures": first_runs,
        "analysis": {
            "metrics": analysis_metrics,
            "candidate_pair_count": len(candidate_pairs),
            "all_pair_count": candidate_selection.all_pair_count,
            "candidate_pairs": candidate_pairs,
            "comparisons": comparisons,
        },
        "embedding_probes": probes,
        "known_trim": {
            "source_start": KNOWN_TRIM_START,
            "source_end": KNOWN_TRIM_END,
            "tolerance_seconds": 1.25,
        },
    }


def _comparison(result: dict[str, Any], key: str) -> dict[str, Any]:
    return result["analysis"]["comparisons"][key]


def _parse_worker_json(stdout: str) -> dict[str, Any]:
    """Parse the final JSON line after model-loading diagnostics."""

    for line in reversed((stdout or "").splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise RuntimeError(f"worker returned no JSON result: {(stdout or '')[-2000:]}")


def _validate_worker_result(result: dict[str, Any]) -> None:
    if result.get("status") == "skipped":
        return
    if result.get("status") != "ok":
        raise AssertionError(f"worker did not complete: {result}")
    comparisons = result["analysis"]["comparisons"]
    expected_not_different = ("base__exact_clip", "base__transformed_clip", "base__speed_clip", "base__short_clip")
    for key in expected_not_different:
        if comparisons[key]["relation"] == "different":
            raise AssertionError(f"real CLIP failed to recognize expected overlap: {key}")
    if comparisons["base__unrelated"]["relation"] != "different":
        raise AssertionError(
            "unrelated fixture was not classified as different: "
            f"{comparisons['base__unrelated']}"
        )
    exact_segments = comparisons["base__exact_clip"]["segments"]
    if not exact_segments:
        raise AssertionError("exact clip produced no temporal segment")
    # Bidirectional fusion can retain a zero-width reverse-coordinate segment
    # with the same confidence as the forward segment.  Choose the candidate
    # with the greatest overlap against the known trim before comparing its
    # boundary error.
    best = max(
        exact_segments,
        key=lambda item: (
            max(
                0.0,
                min(item["source_end"], KNOWN_TRIM_END)
                - max(item["source_start"], KNOWN_TRIM_START),
            ),
            item["source_end"] - item["source_start"],
            item["confidence"],
        ),
    )
    tolerance = float(result["known_trim"]["tolerance_seconds"])
    if abs(best["source_start"] - KNOWN_TRIM_START) > tolerance or abs(best["source_end"] - KNOWN_TRIM_END) > tolerance:
        raise AssertionError(f"exact segment boundary error exceeds tolerance: {best}")
    for name, fixture in result["fixtures"].items():
        if not fixture.get("cache_hit"):
            raise AssertionError(f"second pass was not a cache hit for {name}")


def _compare_cpu_gpu(cpu: dict[str, Any], gpu: dict[str, Any]) -> dict[str, Any]:
    if cpu.get("status") != "ok" or gpu.get("status") != "ok":
        return {"status": "skipped", "reason": "CPU/CUDA parity requires both workers"}
    cpu_pairs = cpu["analysis"]["candidate_pairs"]
    gpu_pairs = gpu["analysis"]["candidate_pairs"]
    if cpu_pairs != gpu_pairs:
        raise AssertionError("CPU and CUDA candidate pair lists differ")
    relation_diffs = {}
    boundary_diffs = {}
    for key, cpu_comparison in cpu["analysis"]["comparisons"].items():
        gpu_comparison = gpu["analysis"]["comparisons"][key]
        if cpu_comparison["relation"] != gpu_comparison["relation"]:
            raise AssertionError(f"CPU/CUDA relation differs for {key}")
        relation_diffs[key] = cpu_comparison["relation"]
        cpu_segments = cpu_comparison["segments"]
        gpu_segments = gpu_comparison["segments"]
        if bool(cpu_segments) != bool(gpu_segments):
            raise AssertionError(f"CPU/CUDA segment presence differs for {key}")
        if cpu_segments and gpu_segments:
            def boundary_delta(left: dict[str, Any], right: dict[str, Any]) -> float:
                return max(
                    abs(left["source_start"] - right["source_start"]),
                    abs(left["source_end"] - right["source_end"]),
                    abs(left["target_start"] - right["target_start"]),
                    abs(left["target_end"] - right["target_end"]),
                )

            # Bidirectional aggregation can emit a forward and a reverse
            # coordinate candidate with identical confidence.  Compare the
            # segment sets instead of relying on list order or a tie-breaker.
            cpu_to_gpu = max(
                min(boundary_delta(cpu_segment, gpu_segment) for gpu_segment in gpu_segments)
                for cpu_segment in cpu_segments
            )
            gpu_to_cpu = max(
                min(boundary_delta(gpu_segment, cpu_segment) for cpu_segment in cpu_segments)
                for gpu_segment in gpu_segments
            )
            delta = max(cpu_to_gpu, gpu_to_cpu)
            if delta > 1.25:
                raise AssertionError(f"CPU/CUDA segment boundary differs for {key}: {delta}")
            boundary_diffs[key] = delta
    cosine_diffs = {}
    for name in FIXTURE_NAMES:
        cpu_probe = cpu["embedding_probes"][name]
        gpu_probe = gpu["embedding_probes"][name]
        if len(cpu_probe) != len(gpu_probe):
            raise AssertionError(f"CPU/CUDA probe frame count differs for {name}")
        cosine_diffs[name] = [
            _cosine(left, right) for left, right in zip(cpu_probe, gpu_probe)
        ]
        if cosine_diffs[name] and min(cosine_diffs[name]) < 0.995:
            raise AssertionError(f"CPU/CUDA embedding cosine drift is too high for {name}: {cosine_diffs[name]}")
    return {
        "status": "ok",
        "relations": relation_diffs,
        "max_segment_boundary_diffs": boundary_diffs,
        "embedding_probe_cosines": cosine_diffs,
    }


def _run_batch_compare(args: argparse.Namespace, fixture_root: Path, cache_root: Path) -> dict[str, Any]:
    # batch_compare treats the final suffix of --output as disposable.  Keep
    # the generated base name free of additional dots so a benchmark named
    # ``foo.final.json`` cannot be silently collapsed to ``foo.json`` and
    # overwrite another report.
    output_path = Path(args.output)
    safe_stem = output_path.stem.replace(".", "_")
    output_base = output_path.with_name(f"{safe_stem}_batch")
    _diag(f"batch start output={args.output} output_base={output_base}")
    batch_cache = cache_root
    command = [
        _resolve_python(args.python),
        str(ROOT / "scripts" / "batch_compare.py"),
        "--input",
        str(fixture_root),
        "--cache-dir",
        str(batch_cache),
        "--output",
        str(output_base),
        "--task-id",
        "e2e-batch",
        "--candidate-limit",
        "0",
        "--skip-threshold",
        str(SAMPLER_SKIP_THRESHOLD),
        "--max-gap-sec",
        str(SAMPLER_MAX_GAP_SEC),
        "--match-threshold",
        str(E2E_MATCH_THRESHOLD),
        "--compare-workers",
        "1",
        "--device",
        "cpu",
        "--skip-stream-validation",
    ]
    _diag(f"batch command output_arg={command[command.index('--output') + 1]}")
    environment = os.environ.copy()
    environment["VIDEO_SIM_CLIP_MODEL_DIR"] = str(Path(args.model_dir).resolve())
    environment["VIDEO_SIM_CLIP_AUTOCAST"] = "0"
    started = time.perf_counter()
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=environment,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr.strip() or completed.stdout.strip())[-4000:]
        raise RuntimeError(f"batch_compare failed with exit code {completed.returncode}: {detail}")
    report_path = output_base.with_suffix(".json")
    if not report_path.exists():
        raise RuntimeError(f"batch_compare did not write {report_path}")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    manifest_path = batch_cache / "cache" / "tasks" / "e2e-batch" / "task.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    return {
        "status": "ok",
        "wall_elapsed_ms": round((time.perf_counter() - started) * 1000.0, 3),
        "report_path": str(report_path),
        "expected_report_path": str(report_path),
        "num_pairs": report.get("num_pairs", 0),
        "candidate_pairs": report.get("candidate_pairs", 0),
        "warnings": len(report.get("warnings", [])),
        "failed_pairs": int(manifest.get("failedPairs", 0) or 0),
        "completed_pairs": int(manifest.get("completedPairs", 0) or 0),
        "resume_fields_present": all(
            key in manifest for key in ("completedPairs", "failedPairs", "status")
        ),
        "metrics": report.get("metrics", {}),
    }


def _run_orchestrator(args: argparse.Namespace) -> dict[str, Any]:
    runtime_python = _resolve_python(args.python)
    ffmpeg = _find_ffmpeg(args.ffmpeg)
    fixture_root = Path(args.fixtures)
    fixtures = _ensure_fixtures(fixture_root, ffmpeg, force=args.force_fixtures)
    del fixtures
    requested_devices = [item.strip().lower() for item in args.devices.split(",") if item.strip()]
    worker_results: dict[str, dict[str, Any]] = {}
    for device in requested_devices:
        command = [
            runtime_python,
            str(Path(__file__).resolve()),
            "--worker",
            "--device",
            device,
            "--model-dir",
            str(Path(args.model_dir).resolve()),
            "--fixtures",
            str(fixture_root.resolve()),
            "--cache-dir",
            str((Path(args.cache_dir) / device).resolve()),
            "--queue-size",
            str(args.queue_size),
        ]
        environment = os.environ.copy()
        environment["VIDEO_SIM_CLIP_MODEL_DIR"] = str(Path(args.model_dir).resolve())
        environment["VIDEO_SIM_CLIP_AUTOCAST"] = "0"
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
            check=False,
        )
        if completed.returncode != 0:
            detail = (completed.stderr.strip() or completed.stdout.strip())[-6000:]
            raise RuntimeError(f"{device} worker failed with exit code {completed.returncode}: {detail}")
        try:
            worker_results[device] = _parse_worker_json(completed.stdout)
        except RuntimeError as error:
            raise RuntimeError(f"{device} worker returned invalid JSON: {completed.stdout[-2000:]}") from error
        _validate_worker_result(worker_results[device])

    parity = {"status": "skipped", "reason": "CUDA worker was not run"}
    if worker_results.get("cpu", {}).get("status") == "ok" and worker_results.get("cuda", {}).get("status") == "ok":
        parity = _compare_cpu_gpu(worker_results["cpu"], worker_results["cuda"])
    batch = _run_batch_compare(args, fixture_root, Path(args.cache_dir) / "cpu") if worker_results.get("cpu", {}).get("status") == "ok" else {"status": "skipped", "reason": "CPU worker unavailable"}
    run_status = "ok" if any(item.get("status") == "ok" for item in worker_results.values()) else "skipped"
    return {
        "mode": "real_clip_end_to_end",
        "status": run_status,
        "python": runtime_python,
        "fixture_type": "locally generated synthetic media; embeddings are real local CLIP inference",
        "ffmpeg": ffmpeg,
        "model_dir": str(Path(args.model_dir).resolve()),
        "fixtures": [str(path) for path in sorted(fixture_root.glob("*.mp4"))],
        "workers": worker_results,
        "cpu_cuda_parity": parity,
        "batch_compare": batch,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--devices", default="cpu,cuda")
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument(
        "--python",
        dest="python",
        type=Path,
        default=None,
        help="Python runtime for worker/batch subprocesses (or VIDEO_SIM_PYTHON)",
    )
    parser.add_argument("--ffmpeg", default=None)
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=ROOT / "data" / "benchmarks" / "e2e_fixtures",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=ROOT / "data" / "benchmarks" / "e2e_cache",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "data" / "benchmarks" / "benchmark_end_to_end.json",
    )
    parser.add_argument("--queue-size", type=int, default=2)
    parser.add_argument("--force-fixtures", action="store_true")
    args = parser.parse_args()
    if args.worker:
        result = _run_worker(args)
        print(json.dumps(result, ensure_ascii=False))
        return
    result = _run_orchestrator(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"Benchmark JSON: {args.output}")


if __name__ == "__main__":
    main()
