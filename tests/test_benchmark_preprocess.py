"""Focused checks for the round-two sampler/preprocess benchmark harness."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
from types import SimpleNamespace
import subprocess
import sys

import numpy as np
import pytest


ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = ROOT / "scripts" / "benchmark_preprocess.py"
BASELINE_DIR = ROOT / "data" / "upgrade_round2_20260831" / "baseline"
BASE_VIDEO = ROOT / "data" / "upgrade_20260831" / "e2e_fixtures" / "base.mp4"


def _benchmark_module():
    spec = importlib.util.spec_from_file_location("round2_benchmark_under_test", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fixture_baseline(tmp_path: Path) -> Path:
    """Build an isolated baseline fixture without depending on ignored data."""

    baseline = tmp_path / "baseline"
    baseline.mkdir()
    shutil.copyfile(ROOT / "video_sim" / "preprocess.py", baseline / "preprocess.py")
    shutil.copyfile(ROOT / "video_sim" / "frame_sampler.py", baseline / "frame_sampler.py")
    return baseline


def test_parser_defaults_and_repeatable_video():
    benchmark = _benchmark_module()
    args = benchmark.build_parser().parse_args(["--video", "one.mp4", "--video", "two.mp4"])
    assert args.warmup == 2
    assert args.repeats == 5
    assert args.video == [Path("one.mp4"), Path("two.mp4")]


def test_baseline_snapshot_binding_and_hashes(tmp_path):
    benchmark = _benchmark_module()
    baseline_dir = _fixture_baseline(tmp_path)
    identity = benchmark._baseline_identity(baseline_dir)
    assert identity["files"]["preprocess.py"]["sha256"] == benchmark._sha256_file(
        baseline_dir / "preprocess.py"
    )
    assert identity["files"]["frame_sampler.py"]["sha256"] == benchmark._sha256_file(
        baseline_dir / "frame_sampler.py"
    )

    benchmark._common_import_warmup()
    saved_preprocess = sys.modules.get("video_sim.preprocess")
    saved_sampler = sys.modules.get("video_sim.frame_sampler")
    with benchmark.variant_module_context():
        runtime = benchmark.load_variant("baseline", baseline_dir)
        assert Path(runtime["preprocess_path"]).resolve() == (baseline_dir / "preprocess.py").resolve()
        assert Path(runtime["sampler_path"]).resolve() == (baseline_dir / "frame_sampler.py").resolve()
        assert runtime["sampler"].PreprocessConfig is runtime["preprocess"].PreprocessConfig
    assert sys.modules.get("video_sim.preprocess") is saved_preprocess
    assert sys.modules.get("video_sim.frame_sampler") is saved_sampler


@pytest.mark.parametrize("field", ["frame_index", "timestamp", "phash", "clip_frame"])
def test_frame_digest_covers_each_correctness_field(field):
    benchmark = _benchmark_module()
    frame = SimpleNamespace(
        frame_index=3,
        timestamp=1.25,
        phash="abc",
        clip_frame=np.zeros((2, 2, 3), dtype=np.uint8),
    )
    first = benchmark._frame_digest([frame])["digest"]
    if field == "clip_frame":
        frame.clip_frame[0, 0, 0] = 1
    elif field == "phash":
        frame.phash = "abd"
    elif field == "timestamp":
        frame.timestamp = 1.5
    else:
        frame.frame_index = 4
    assert benchmark._frame_digest([frame])["digest"] != first


def test_micro_wrapper_digest_excludes_runtime_telemetry():
    benchmark = _benchmark_module()
    pixels = np.arange(12, dtype=np.uint8).reshape(2, 2, 3)
    first = benchmark._micro_output_digest("abc", pixels)
    # The helper has no timing/resource inputs, so the same hash and pixels
    # remain identical regardless of surrounding telemetry.
    second = benchmark._micro_output_digest("abc", pixels.copy())
    assert first == second
    assert first != benchmark._micro_output_digest("abd", pixels)
    pixels[0, 0, 0] ^= 1
    assert first != benchmark._micro_output_digest("abc", pixels)


def test_real_base_sampler_comparison_in_fresh_workers(tmp_path):
    try:
        import decord  # noqa: F401
    except ImportError:
        pytest.skip("decord is required for the real fixture worker check")
    if getattr(decord, "VideoReader", None) is object:
        pytest.skip("decord stub is active; real fixture worker check is unavailable")
    if not BASE_VIDEO.is_file() or not BASELINE_DIR.is_dir():
        pytest.skip("round-two baseline or base fixture is unavailable")

    output = tmp_path / "benchmark.json"
    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--baseline-dir",
            str(BASELINE_DIR),
            "--video",
            str(BASE_VIDEO),
            "--warmup",
            "0",
            "--repeats",
            "1",
            "--output",
            str(output),
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert completed.returncode == 0, completed.stderr[-4000:]
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["status"] == "ok"
    assert report["correctness"]["status"] == "pass"
    assert report["raw_runs"][0]["order"] == ["baseline", "current"]
    for variant in ("baseline", "current"):
        row = report["raw_runs"][0]["results"][variant]["videos"][str(BASE_VIDEO.resolve())]
        assert row["frame_cache_used"] is False
        assert row["retained_count"] > 0
        assert row["listing"]["digest"]["clip_pixels_sha256"]
        assert row["process"]["sample_peak_delta_bytes"] is not None
        assert "preprocess" in row["stage_metrics"]["stages"]


def test_micro_case_has_independent_pipelines_and_sampler_wrapper(tmp_path):
    benchmark = _benchmark_module()
    try:
        benchmark._common_import_warmup()
    except ImportError:
        pytest.skip("benchmark dependencies are unavailable")
    baseline_dir = _fixture_baseline(tmp_path)
    metrics_module = benchmark._common_import_warmup()
    with benchmark.variant_module_context():
        runtime = benchmark.load_variant("current", baseline_dir)
        case = benchmark._run_micro_case(
            runtime,
            "unit",
            (24, 32),
            False,
            0,
            metrics_module,
        )
    assert case["geometry"]["output_shape"] == [224, 224, 3]
    assert case["hash_pipeline"]["output_shape"] == [224, 224, 3]
    assert case["clip_pipeline"]["output_shape"] == [224, 224, 3]
    assert case["sampler_combined_wrapper"]["diagnostic_only"] is True
    assert case["sampler_combined_wrapper"]["retained_count"] == 1
    assert case["sampler_combined_wrapper"]["correctness_digest"]
