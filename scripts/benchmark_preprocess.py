#!/usr/bin/env python3
"""Exploratory CPU sampler/preprocess comparison for recognition round two.

The benchmark deliberately measures the old and current implementation in
different child processes.  A child imports the common runtime first, then
loads exactly one variant and performs sampling without an application frame
cache.  The operating-system page cache is not flushed, so the result is a
no-frame-cache measurement whose decoder reads may still be OS-hot.

The command is intentionally exploratory.  It records every raw repetition
and medians, but does not calculate confidence intervals, p-values, or claim
an overall accuracy or speed improvement.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import gc
import hashlib
import importlib
import importlib.util
import json
import math
import os
from pathlib import Path
import statistics
import struct
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, Iterable

import numpy as np


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DEFAULT_BASELINE_DIR = ROOT / "data" / "upgrade_round2_20260831" / "baseline"
DEFAULT_VIDEO = ROOT / "data" / "upgrade_20260831" / "e2e_fixtures" / "base.mp4"
DEFAULT_OUTPUT = ROOT / "data" / "upgrade_round2_20260831" / "benchmark_preprocess.json"
BASELINE_FILES = ("preprocess.py", "frame_sampler.py")
SAMPLER_PARAMETERS = {
    "skip_threshold": 0.90,
    "max_gap_sec": 5.0,
    "frame_step": 1,
}

# The six cases are deliberately small in count.  A single generated frame is
# held for one case at a time; no list of 4K frames is retained.
MICRO_SCENARIOS = (
    ("1080p", (1080, 1920)),
    ("4k", (2160, 3840)),
    ("portrait", (1920, 1080)),
)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _baseline_identity(baseline_dir: Path) -> dict[str, Any]:
    """Validate and describe the immutable round-two baseline snapshot."""

    baseline_dir = baseline_dir.expanduser().resolve()
    files: dict[str, Any] = {}
    for name in BASELINE_FILES:
        path = baseline_dir / name
        if not path.is_file():
            raise FileNotFoundError(
                f"baseline snapshot is incomplete: expected {path}; "
                "use the round-two baseline made from git index sampler + HEAD preprocess"
            )
        files[name] = {
            "path": str(path),
            "sha256": _sha256_file(path),
            "bytes": path.stat().st_size,
        }

    manifest = baseline_dir / "SHA256SUMS.txt"
    if manifest.is_file():
        files["manifest"] = {
            "path": str(manifest),
            "sha256": _sha256_file(manifest),
        }
    return {"directory": str(baseline_dir), "files": files}


def _common_import_warmup() -> Any:
    """Import dependencies shared by both variants before timing starts."""

    # Keep these imports in one place.  In particular, importing imagehash,
    # PIL, cv2, and decord is outside the sample timer for both variants.
    import cv2  # noqa: F401
    import imagehash  # noqa: F401
    from PIL import Image  # noqa: F401
    import decord  # noqa: F401
    from video_sim import metrics

    # Warm the same optional probe used by RecognitionMetrics before the
    # process-lifetime baseline is captured for a measured run.
    metrics.cuda_memory_snapshot()
    return metrics


def _load_module_from_file(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot create import spec for {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


@contextmanager
def variant_module_context():
    """Temporarily bind canonical variant modules for focused in-process use.

    Benchmark workers are short-lived processes, but tests and notebook users
    may load both variants in one interpreter.  Restoring both ``sys.modules``
    and package attributes prevents a baseline import from leaking into a
    later current-runtime import.
    """

    names = ("video_sim.preprocess", "video_sim.frame_sampler")
    saved_modules = {name: sys.modules.get(name) for name in names}
    package = sys.modules.get("video_sim")
    saved_attributes = {
        name.rsplit(".", 1)[-1]: getattr(package, name.rsplit(".", 1)[-1], None)
        for name in names
    } if package is not None else {}
    try:
        yield
    finally:
        for name, module in saved_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        if package is not None:
            for attribute, value in saved_attributes.items():
                if value is None:
                    try:
                        delattr(package, attribute)
                    except AttributeError:
                        pass
                else:
                    setattr(package, attribute, value)


def load_variant(variant: str, baseline_dir: Path) -> dict[str, Any]:
    """Load one implementation, keeping baseline preprocess canonical.

    ``frame_sampler.py`` imports ``video_sim.preprocess`` by name.  Baseline
    workers therefore install the baseline preprocess module under that exact
    name before loading baseline sampler.  Workers are one-variant processes;
    the purge also makes this helper safe for focused tests that load both
    variants sequentially.
    """

    if variant not in {"baseline", "current"}:
        raise ValueError(f"unknown variant: {variant}")

    for module_name in ("video_sim.frame_sampler", "video_sim.preprocess"):
        sys.modules.pop(module_name, None)

    if variant == "baseline":
        preprocess_path = baseline_dir / "preprocess.py"
        sampler_path = baseline_dir / "frame_sampler.py"
        preprocess_module = _load_module_from_file("video_sim.preprocess", preprocess_path)
        sampler_module = _load_module_from_file("video_sim.frame_sampler", sampler_path)
    else:
        importlib.invalidate_caches()
        preprocess_module = importlib.import_module("video_sim.preprocess")
        sampler_module = importlib.import_module("video_sim.frame_sampler")
        preprocess_path = Path(preprocess_module.__file__).resolve()
        sampler_path = Path(sampler_module.__file__).resolve()

    # Round-two sampler may import the legacy public wrappers or the new
    # shared-geometry helpers.  The class identity is the strongest binding
    # check: it proves that sampler and the selected preprocess module share
    # the exact module object, even when helper names differ.
    sampler_config = getattr(sampler_module, "PreprocessConfig", None)
    preprocess_config = getattr(preprocess_module, "PreprocessConfig", None)
    if sampler_config is not preprocess_config:
        raise RuntimeError(
            f"{variant} sampler did not bind to the selected video_sim.preprocess module"
        )
    if variant == "baseline" and Path(preprocess_module.__file__).resolve() != preprocess_path.resolve():
        raise RuntimeError("baseline sampler was not bound to baseline preprocess.py")

    return {
        "variant": variant,
        "preprocess": preprocess_module,
        "sampler": sampler_module,
        "preprocess_path": str(preprocess_path.resolve()),
        "sampler_path": str(sampler_path.resolve()),
        "preprocess_sha256": _sha256_file(preprocess_path),
        "sampler_sha256": _sha256_file(sampler_path),
    }


def _metric_process_fields(metrics_dict: dict[str, Any]) -> dict[str, Any]:
    """Select explicit process memory fields and state their limitations."""

    return {
        "baseline_rss_bytes": metrics_dict.get("baseline_rss_bytes"),
        "current_rss_bytes": metrics_dict.get("current_rss_bytes"),
        "peak_rss_bytes": metrics_dict.get("observed_peak_rss_bytes", metrics_dict.get("peak_rss_bytes")),
        "process_peak_minus_baseline_rss_bytes": metrics_dict.get("peak_rss_delta_bytes"),
        # Deprecated compatibility alias; retain its existing value and
        # process-lifetime high-water semantics.
        "sample_peak_delta_bytes": metrics_dict.get("peak_rss_delta_bytes"),
        "rss_semantics": (
            "process-lifetime highwater minus post-warmup start RSS; this is not the "
            "peak RSS observed during this sampling phase and does not support conclusions "
            "about memory decreases"
        ),
    }


def _frame_digest(frames: Iterable[Any]) -> dict[str, Any]:
    """Digest all retained metadata and all retained CLIP pixels.

    Metadata and pixels are streamed into separate hashes so the report makes
    the correctness coverage auditable without embedding large arrays in JSON.
    Shape and dtype are included before every pixel payload.
    """

    metadata_hash = hashlib.sha256()
    pixel_hash = hashlib.sha256()

    def add(hash_obj, payload: bytes) -> None:
        hash_obj.update(struct.pack("<Q", len(payload)))
        hash_obj.update(payload)

    count = 0
    for retained in frames:
        frame_index = int(retained.frame_index)
        timestamp = float(retained.timestamp)
        phash = str(retained.phash).encode("utf-8")
        metadata_hash.update(struct.pack("<qd", frame_index, timestamp))
        add(metadata_hash, phash)

        clip_frame = np.asarray(retained.clip_frame)
        if clip_frame.dtype != np.uint8:
            clip_frame = clip_frame.astype(np.uint8, copy=False)
        clip_frame = np.ascontiguousarray(clip_frame)
        shape = json.dumps(list(clip_frame.shape), separators=(",", ":")).encode("ascii")
        add(pixel_hash, str(clip_frame.dtype).encode("ascii"))
        add(pixel_hash, shape)
        add(pixel_hash, clip_frame.tobytes(order="C"))
        count += 1

    metadata_digest = metadata_hash.hexdigest()
    clip_digest = pixel_hash.hexdigest()
    overall = hashlib.sha256(
        b"round2-frame-digest-v1\0" + metadata_digest.encode("ascii") + b"\0" + clip_digest.encode("ascii")
    ).hexdigest()
    return {
        "digest_version": "round2-frame-digest-v1",
        "digest": overall,
        "metadata_sha256": metadata_digest,
        "clip_pixels_sha256": clip_digest,
        "retained_count": count,
        "coverage": "all frame_indices, timestamps, phash strings, clip pixel bytes, shape, and dtype",
    }


def _frame_listing(frames: list[Any]) -> dict[str, Any]:
    digest = _frame_digest(frames)
    return {
        "frame_indices": [int(frame.frame_index) for frame in frames],
        "timestamps": [float(frame.timestamp) for frame in frames],
        "phashes": [str(frame.phash) for frame in frames],
        "digest": digest,
    }


def _new_sampler(runtime: dict[str, Any], metrics: Any, cache_dir: Path):
    sampler_class = runtime["sampler"].DynamicFrameSampler
    return sampler_class(
        skip_threshold=SAMPLER_PARAMETERS["skip_threshold"],
        max_gap_sec=SAMPLER_PARAMETERS["max_gap_sec"],
        frame_step=SAMPLER_PARAMETERS["frame_step"],
        # A private temporary path prevents any incidental legacy thumbnail
        # write from touching repository media/caches.  The benchmark itself
        # never reads a frame cache and deletes this path at worker exit.
        cache_dir=cache_dir,
        preprocess_config=runtime["preprocess"].PreprocessConfig(),
        metrics=metrics,
    )


def _sample_video_once(runtime: dict[str, Any], video_path: Path, cache_dir: Path, metrics: Any) -> dict[str, Any]:
    sampler = _new_sampler(runtime, metrics, cache_dir)
    wall_started = time.perf_counter()
    cpu_started = time.process_time()
    frames = sampler.sample(video_path)
    wall_ms = max(0.0, (time.perf_counter() - wall_started) * 1000.0)
    cpu_ms = max(0.0, (time.process_time() - cpu_started) * 1000.0)

    # ``decode_sample`` is intentionally inclusive: it is the complete
    # sampler.sample wall interval, including decode, colour conversion,
    # geometry, pHash, retained-frame preparation, and sampler telemetry.
    # ``sampler_*`` and ``preprocess`` entries below are nested diagnostics;
    # they must not be added together to reconstruct this interval.
    metrics.record_stage(
        "decode_sample",
        wall_ms / 1000.0,
        items=int(getattr(sampler, "total_frames", 0)),
    )
    metrics.set_count("frames_seen", int(getattr(sampler, "total_frames", 0)))
    metrics.set_count("frames_retained", int(len(frames)))
    metrics.set_count("preprocess_calls", int(getattr(sampler, "_preprocess_calls", 0)))
    sample_attempts = getattr(sampler, "_sampler_sampled_frames", None)
    if sample_attempts is not None:
        metrics.set_count("sampler_sampled_frames", int(sample_attempts))
    metric_dict = metrics.to_dict()
    listing = _frame_listing(frames)
    listing["retained_count"] = len(frames)
    listing["total_frames"] = int(getattr(sampler, "total_frames", 0))
    listing["source_duration_sec"] = float(getattr(sampler, "source_duration_sec", 0.0))
    listing["decode_batch_size"] = getattr(sampler, "last_decode_batch_size", None)
    listing["decode_frame_bytes"] = getattr(sampler, "last_decode_frame_bytes", None)
    listing["decode_batch_oversized"] = bool(getattr(sampler, "last_decode_batch_oversized", False))
    return {
        "video": str(video_path.resolve()),
        "wall_ms": round(wall_ms, 3),
        "cpu_ms": round(cpu_ms, 3),
        "retained_count": len(frames),
        "listing": listing,
        "stage_metrics": metric_dict,
        # Keep the concise name used by the existing recognition reports while
        # retaining the explicit stage_metrics spelling for this benchmark.
        "metrics": metric_dict,
        "process": _metric_process_fields(metric_dict),
        "frame_cache_used": False,
        "timing_semantics": {
            "decode_sample": "inclusive sampler.sample wall interval; contains sampler_* and preprocess nested diagnostics",
            "sampler_substages_additive": False,
            "frames_seen": "sampler.total_frames decoder frame count; not sample-attempt count",
        },
        "sampler_sampled_frames": (
            int(sample_attempts) if sample_attempts is not None else "unavailable"
        ),
    }


def _warmup_video(runtime: dict[str, Any], video_path: Path, cache_dir: Path, count: int) -> None:
    for _ in range(max(0, int(count))):
        sampler = _new_sampler(runtime, None, cache_dir)
        sampler.sample(video_path)
        del sampler
        gc.collect()


def _generate_synthetic_frame(height: int, width: int) -> np.ndarray:
    """Create one deterministic BGR test frame using NumPy only."""

    frame = np.zeros((height, width, 3), dtype=np.uint8)
    border_y = max(8, height // 12)
    border_x = max(8, width // 12)
    top, bottom = border_y, height - border_y
    left, right = border_x, width - border_x
    frame[top:bottom, left:right, 0] = 38
    frame[top:bottom, left:right, 1] = 154
    frame[top:bottom, left:right, 2] = 224
    # A few deterministic blocks make the pHash useful while keeping
    # generation O(pixels) and avoiding temporary mesh grids.
    block_h = max(1, (bottom - top) // 5)
    block_w = max(1, (right - left) // 7)
    frame[top + block_h : top + 2 * block_h, left + block_w : left + 2 * block_w] = (230, 80, 35)
    frame[top + 3 * block_h : top + 4 * block_h, left + 4 * block_w : left + 6 * block_w] = (28, 210, 96)
    return frame


def _time_pipeline(function: Callable[[], Any]) -> tuple[Any, float, float]:
    cpu_started = time.process_time()
    wall_started = time.perf_counter()
    value = function()
    return value, (time.perf_counter() - wall_started) * 1000.0, (time.process_time() - cpu_started) * 1000.0


def _pixel_sha256(value: Any) -> str:
    array = np.ascontiguousarray(np.asarray(value, dtype=np.uint8))
    return hashlib.sha256(array.tobytes(order="C")).hexdigest()


def _micro_output_digest(phash: str, clip_frame: Any) -> str:
    """Digest only pHash and CLIP pixels for micro correctness checks."""

    clip = np.ascontiguousarray(np.asarray(clip_frame, dtype=np.uint8))
    digest = hashlib.sha256()
    digest.update(b"round2-micro-digest-v1\0")
    encoded_phash = str(phash).encode("utf-8")
    digest.update(struct.pack("<Q", len(encoded_phash)))
    digest.update(encoded_phash)
    digest.update(clip.tobytes(order="C"))
    return digest.hexdigest()


def _run_micro_case(runtime: dict[str, Any], name: str, shape: tuple[int, int], crop: bool, warmup: int, metrics_module: Any) -> dict[str, Any]:
    height, width = shape
    # Frame construction intentionally precedes all timers.
    frame = _generate_synthetic_frame(height, width)
    config = runtime["preprocess"].PreprocessConfig(crop_black_borders=crop)

    def pipelines() -> tuple[Any, Any, Any]:
        geometry = runtime["preprocess"].preprocess_frame_geometry(frame, config)
        hash_frame = runtime["preprocess"].preprocess_frame_for_hash(frame, config)
        clip_frame = runtime["preprocess"].preprocess_frame_for_clip(frame, config)
        from PIL import Image
        import cv2
        import imagehash

        phash = str(imagehash.phash(Image.fromarray(cv2.cvtColor(hash_frame, cv2.COLOR_BGR2RGB))))
        return geometry, phash, clip_frame

    def sampler_wrapper() -> list[Any]:
        """Diagnostic wrapper for the production sampler's combined path."""

        sampler = runtime["sampler"].DynamicFrameSampler(
            skip_threshold=SAMPLER_PARAMETERS["skip_threshold"],
            max_gap_sec=SAMPLER_PARAMETERS["max_gap_sec"],
            frame_step=SAMPLER_PARAMETERS["frame_step"],
            cache_dir=Path(tempfile.gettempdir()),
            preprocess_config=config,
            metrics=None,
        )
        retained: list[Any] = []
        sampler._consider_frame(
            frame=frame,
            frame_index=0,
            timestamp=0.0,
            retained_frames=retained,
            last_retained_hash=None,
            last_retained_index=-1,
            max_gap_frames=1,
            video_path=Path("round2_micro"),
        )
        return retained

    for _ in range(max(0, int(warmup))):
        pipelines()
        sampler_wrapper()
        gc.collect()

    metrics = metrics_module.RecognitionMetrics()
    geometry, geometry_wall, geometry_cpu = _time_pipeline(
        lambda: runtime["preprocess"].preprocess_frame_geometry(frame, config)
    )

    def hash_pipeline() -> tuple[Any, str]:
        import cv2
        import imagehash
        from PIL import Image

        hash_frame = runtime["preprocess"].preprocess_frame_for_hash(frame, config)
        return hash_frame, str(imagehash.phash(Image.fromarray(cv2.cvtColor(hash_frame, cv2.COLOR_BGR2RGB))))

    (hash_frame, phash), hash_wall, hash_cpu = _time_pipeline(hash_pipeline)
    clip_frame, clip_wall, clip_cpu = _time_pipeline(
        lambda: runtime["preprocess"].preprocess_frame_for_clip(frame, config)
    )
    combo_frames, combo_wall, combo_cpu = _time_pipeline(sampler_wrapper)
    if not combo_frames:
        raise RuntimeError(f"sampler wrapper did not retain synthetic {name} frame")
    combo_digest = _micro_output_digest(combo_frames[0].phash, combo_frames[0].clip_frame)
    metrics.record_stage("preprocess", (geometry_wall + hash_wall + clip_wall) / 1000.0, items=3)
    metric_dict = metrics.to_dict()
    return {
        "scenario": name,
        "input_shape": [height, width, 3],
        "crop_black_borders": bool(crop),
        "source_generation": "numpy_single_frame_outside_timers",
        "geometry": {
            "wall_ms": round(max(0.0, geometry_wall), 3),
            "cpu_ms": round(max(0.0, geometry_cpu), 3),
            "output_shape": list(np.asarray(geometry).shape),
            "pixels_sha256": _pixel_sha256(geometry),
        },
        "hash_pipeline": {
            "wall_ms": round(max(0.0, hash_wall), 3),
            "cpu_ms": round(max(0.0, hash_cpu), 3),
            "phash": phash,
            "output_shape": list(np.asarray(hash_frame).shape),
        },
        "clip_pipeline": {
            "wall_ms": round(max(0.0, clip_wall), 3),
            "cpu_ms": round(max(0.0, clip_cpu), 3),
            "output_shape": list(np.asarray(clip_frame).shape),
            "pixels_sha256": _pixel_sha256(clip_frame),
        },
        "sampler_combined_wrapper": {
            "diagnostic_only": True,
            "description": "DynamicFrameSampler._consider_frame forced-retain one synthetic frame; wrapper timing",
            "wall_ms": round(max(0.0, combo_wall), 3),
            "cpu_ms": round(max(0.0, combo_cpu), 3),
            "retained_count": len(combo_frames),
            "phash": str(combo_frames[0].phash),
            "clip_pixels_sha256": _pixel_sha256(combo_frames[0].clip_frame),
            "correctness_digest": combo_digest,
        },
        "process": _metric_process_fields(metric_dict),
        "stage_metrics": metric_dict,
    }


def _run_micro(runtime: dict[str, Any], warmup: int, metrics_module: Any) -> dict[str, Any]:
    cases: list[dict[str, Any]] = []
    for name, shape in MICRO_SCENARIOS:
        for crop in (False, True):
            cases.append(_run_micro_case(runtime, name, shape, crop, warmup, metrics_module))
            gc.collect()
    # Correctness digest deliberately excludes timings, RSS, and stage
    # telemetry.  It covers only the deterministic hash and retained CLIP
    # pixels from each fixed-order case.
    digest = hashlib.sha256()
    for case in cases:
        digest.update(case["sampler_combined_wrapper"]["correctness_digest"].encode("ascii"))
    return {
        "frame_count_per_case": 1,
        "cases": cases,
        "digest": digest.hexdigest(),
        "memory_note": "one generated frame per case; 4K frames are released before the next case",
    }


def run_worker(args: argparse.Namespace) -> dict[str, Any]:
    metrics_module = _common_import_warmup()
    baseline_dir = Path(args.baseline_dir).expanduser().resolve()
    baseline_identity = _baseline_identity(baseline_dir)
    runtime = load_variant(args.variant, baseline_dir)

    videos = [Path(value).expanduser().resolve() for value in (args.video or [])]
    for video in videos:
        if not video.is_file():
            raise FileNotFoundError(f"video was not found: {video}")

    temp_cache = Path(tempfile.mkdtemp(prefix=f"video-sim-round2-{args.variant}-"))
    try:
        # Warmups are intentionally unreported and occur before each measured
        # video.  They warm imports/decoder paths while frame cache remains
        # disabled; they may warm the OS page cache.
        for video in videos:
            _warmup_video(runtime, video, temp_cache, args.warmup)
        gc.collect()

        video_results: dict[str, Any] = {}
        for video in videos:
            metrics = metrics_module.RecognitionMetrics()
            video_results[str(video)] = _sample_video_once(runtime, video, temp_cache, metrics)
            gc.collect()

        result: dict[str, Any] = {
            "status": "ok",
            "variant": args.variant,
            "warmup_runs_per_video": int(args.warmup),
            "sampler_parameters": dict(SAMPLER_PARAMETERS),
            "preprocess_config": runtime["preprocess"].PreprocessConfig().to_dict(),
            "fixture_parameter_note": (
                "The default base.mp4 run uses max_gap_sec=5.0 and retains 3 frames; "
                "the separate E2E recognition run uses different fixture parameters "
                "(including max_gap_sec=0.5), so its retain counts are not a benchmark target."
            ),
            "videos": video_results,
            "micro": _run_micro(runtime, args.warmup, metrics_module) if args.micro else None,
            "runtime": {
                "python": sys.executable,
                "platform": sys.platform,
                "pid": os.getpid(),
            },
            "source": {
                key: value
                for key, value in runtime.items()
                if key not in {"preprocess", "sampler"}
            },
            "baseline": baseline_identity,
            "cache_policy": {
                "frame_cache": "disabled; no application frame cache is read or reused",
                "os_page_cache": "not flushed; decoder reads may be OS-hot",
            },
        }
        metrics_path = Path(metrics_module.__file__).resolve()
        result["source"].update(
            {
                "metrics_path": str(metrics_path),
                "metrics_sha256": _sha256_file(metrics_path),
                "benchmark_script_path": str(Path(__file__).resolve()),
                "benchmark_script_sha256": _sha256_file(Path(__file__).resolve()),
            }
        )
        return result
    finally:
        import shutil

        shutil.rmtree(temp_cache, ignore_errors=True)


def _parse_json_result(stdout: str) -> dict[str, Any]:
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
    raise RuntimeError(f"worker produced no JSON result: {(stdout or '')[-2000:]}")


def _run_worker_process(args: argparse.Namespace, variant: str) -> dict[str, Any]:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker",
        "--variant",
        variant,
        "--baseline-dir",
        str(Path(args.baseline_dir).resolve()),
        "--warmup",
        str(args.warmup),
    ]
    if args.micro:
        command.append("--micro")
    for video in (args.video or [DEFAULT_VIDEO]):
        command.extend(("--video", str(Path(video).resolve())))
    completed = subprocess.run(
        command,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        env=os.environ.copy(),
    )
    if completed.returncode != 0:
        detail = (completed.stderr.strip() or completed.stdout.strip())[-4000:]
        raise RuntimeError(
            f"{variant} worker failed with exit code {completed.returncode}: {detail}"
        )
    result = _parse_json_result(completed.stdout)
    if result.get("status") != "ok":
        raise RuntimeError(f"{variant} worker did not complete: {result}")
    return result


def _median(values: list[float]) -> float | None:
    return round(float(statistics.median(values)), 3) if values else None


def _timing_summary(raw_runs: list[dict[str, Any]], videos: list[Path], micro: bool) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for video in videos:
        key = str(video.resolve())
        entry: dict[str, Any] = {}
        for variant in ("baseline", "current"):
            samples = [
                float(run["results"][variant]["videos"][key]["wall_ms"])
                for run in raw_runs
                if key in run["results"][variant].get("videos", {})
            ]
            cpu_samples = [
                float(run["results"][variant]["videos"][key]["cpu_ms"])
                for run in raw_runs
                if key in run["results"][variant].get("videos", {})
            ]
            entry[variant] = {
                "raw_wall_ms": [round(value, 3) for value in samples],
                "median_wall_ms": _median(samples),
                "raw_cpu_ms": [round(value, 3) for value in cpu_samples],
                "median_cpu_ms": _median(cpu_samples),
            }
        summary[key] = entry

    if micro:
        for scenario_name, _shape in MICRO_SCENARIOS:
            for crop in (False, True):
                case_key = f"micro:{scenario_name}:crop={str(crop).lower()}"
                entry = {}
                for variant in ("baseline", "current"):
                    rows = []
                    for run in raw_runs:
                        for case in run["results"][variant].get("micro", {}).get("cases", []):
                            if case["scenario"] == scenario_name and bool(case["crop_black_borders"]) == crop:
                                rows.append(case)
                    entry[variant] = {
                        "raw_geometry_wall_ms": [float(row["geometry"]["wall_ms"]) for row in rows],
                        "median_geometry_wall_ms": _median([float(row["geometry"]["wall_ms"]) for row in rows]),
                        "raw_hash_wall_ms": [float(row["hash_pipeline"]["wall_ms"]) for row in rows],
                        "median_hash_wall_ms": _median([float(row["hash_pipeline"]["wall_ms"]) for row in rows]),
                        "raw_clip_wall_ms": [float(row["clip_pipeline"]["wall_ms"]) for row in rows],
                        "median_clip_wall_ms": _median([float(row["clip_pipeline"]["wall_ms"]) for row in rows]),
                    }
                summary[case_key] = entry
    return summary


def _correctness(raw_runs: list[dict[str, Any]], videos: list[Path], micro: bool) -> dict[str, Any]:
    comparisons: list[dict[str, Any]] = []
    mismatch = False
    for run in raw_runs:
        repeat = int(run["repeat"])
        for video in videos:
            key = str(video.resolve())
            baseline = run["results"]["baseline"]["videos"][key]["listing"]["digest"]
            current = run["results"]["current"]["videos"][key]["listing"]["digest"]
            equal = baseline == current
            mismatch = mismatch or not equal
            comparisons.append(
                {
                    "repeat": repeat,
                    "kind": "video",
                    "video": key,
                    "baseline_digest": baseline,
                    "current_digest": current,
                    "equal": equal,
                }
            )
        if micro:
            baseline = run["results"]["baseline"].get("micro", {}).get("digest")
            current = run["results"]["current"].get("micro", {}).get("digest")
            equal = baseline == current
            mismatch = mismatch or not equal
            comparisons.append(
                {
                    "repeat": repeat,
                    "kind": "micro",
                    "baseline_digest": baseline,
                    "current_digest": current,
                    "equal": equal,
                }
            )
    return {
        "status": "mismatch" if mismatch else "pass",
        "exit_nonzero_on_mismatch": True,
        "comparisons": comparisons,
        "digest_scope": "all retained frame indices, timestamps, phashes, and CLIP pixel bytes",
    }


def run_orchestrator(args: argparse.Namespace) -> dict[str, Any]:
    baseline_dir = Path(args.baseline_dir).expanduser().resolve()
    baseline_identity = _baseline_identity(baseline_dir)
    videos = [Path(value).expanduser().resolve() for value in (args.video or [DEFAULT_VIDEO])]
    for video in videos:
        if not video.is_file():
            raise FileNotFoundError(f"video was not found: {video}")

    raw_runs: list[dict[str, Any]] = []
    for repeat in range(int(args.repeats)):
        order = ("baseline", "current") if repeat % 2 == 0 else ("current", "baseline")
        results: dict[str, Any] = {}
        for variant in order:
            results[variant] = _run_worker_process(args, variant)
        raw_runs.append({"repeat": repeat, "order": list(order), "results": results})

    correctness = _correctness(raw_runs, videos, bool(args.micro))
    first_current = raw_runs[0]["results"]["current"]
    return {
        "schema_version": 1,
        "benchmark": "recognition-round2-cpu-sampler-preprocess",
        "status": "ok" if correctness["status"] == "pass" else "correctness_mismatch",
        "baseline": baseline_identity,
        "parameters": {
            "videos": [str(video) for video in videos],
            "warmup": int(args.warmup),
            "repeats": int(args.repeats),
            "micro": bool(args.micro),
        },
        "sampler_parameters": dict(SAMPLER_PARAMETERS),
        "preprocess_config": dict(first_current["preprocess_config"]),
        "fixture_parameter_note": first_current["fixture_parameter_note"],
        "source_identities": {
            variant: dict(raw_runs[0]["results"][variant]["source"])
            for variant in ("baseline", "current")
        },
        "schedule": {
            "variant_labels": {"baseline": "A (old snapshot)", "current": "B (current working tree)"},
            "order": "AB/BA interleaved by repeat; each variant run uses a fresh child process",
        },
        "cache_policy": {
            "frame_cache": "disabled; no application frame cache is read or reused",
            "os_page_cache": "not flushed; decoder reads may be OS-hot",
            "warmups": "unreported sampling warmups run before each measured video and can warm OS pages",
        },
        "raw_runs": raw_runs,
        "timing_summary": _timing_summary(raw_runs, videos, bool(args.micro)),
        "correctness": correctness,
        "interpretation": (
            "Exploratory development measurement: raw repetitions and medians are reported. "
            "No p-value/CI or claim of overall precision or end-to-end speed improvement is made; "
            "the earlier CPU model remains a likely dominant cost."
        ),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--variant", choices=("baseline", "current"), help=argparse.SUPPRESS)
    parser.add_argument("--baseline-dir", type=Path, default=DEFAULT_BASELINE_DIR)
    parser.add_argument("--video", action="append", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--warmup", type=int, default=2)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument(
        "--micro",
        action="store_true",
        help="also run one-at-a-time NumPy 1080p/4K/portrait crop on/off micro cases",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.warmup < 0:
        raise SystemExit("--warmup must be >= 0")
    if args.repeats < 1 and not args.worker:
        raise SystemExit("--repeats must be >= 1")
    if args.worker:
        if args.variant is None:
            raise SystemExit("worker requires --variant")
        result = run_worker(args)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0

    if args.video is None:
        args.video = [DEFAULT_VIDEO]
    report = run_orchestrator(args)
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    return 0 if report["correctness"]["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
