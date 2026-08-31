from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
import sys
import types

import pytest

from video_sim.evaluation import load_manifest


def _script_module():
    path = Path(__file__).parents[1] / "scripts" / "benchmark_round4.py"
    spec = importlib.util.spec_from_file_location("benchmark_round4_under_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_generate_fixtures_writes_strict_manifest_without_real_encoder(tmp_path: Path, monkeypatch) -> None:
    module = _script_module()

    def fake_find(_explicit):
        return "fake-ffmpeg"

    def fake_ffmpeg(_ffmpeg, arguments, label):
        output = Path(arguments[-1])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(f"fixture-{label}".encode("ascii"))

    monkeypatch.setattr(module, "_find_ffmpeg", fake_find)
    monkeypatch.setattr(module, "_run_ffmpeg", fake_ffmpeg)
    monkeypatch.setattr(module, "_find_ffprobe", lambda _ffmpeg: "fake-ffprobe")
    monkeypatch.setattr(module, "_probe_video", lambda _ffprobe, path: {"width": 320, "height": 180, "fps": 12.0, "duration_seconds": {"short.mp4": 1.5, "speed_2x.mp4": 1.5, "exact.mp4": 3.0, "mirror.mp4": 3.0, "crop.mp4": 3.0}.get(path.name, 12.0), "frame_count": 12})
    fixture_dir = tmp_path / "fixtures"
    manifest_path = tmp_path / "manifest.json"
    assert module.generate_fixtures(fixture_dir=fixture_dir, manifest_path=manifest_path, ffmpeg="fake") == manifest_path.resolve()
    manifest = load_manifest(manifest_path, verify_files=True)
    assert manifest["annotation"]["seed"] == 20260831
    assert {case["groups"][0] for case in manifest["cases"]} == {
        "exact", "short", "mirror", "crop", "2xspeed", "unrelated", "shared_static_template"
    }
    assert (fixture_dir / ".round4-fixtures.json").is_file()


def test_fixture_directory_refuses_unowned_existing_file(tmp_path: Path) -> None:
    module = _script_module()
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    (fixture_dir / "unowned.mp4").write_bytes(b"user")
    try:
        module.generate_fixtures(fixture_dir=fixture_dir, manifest_path=tmp_path / "manifest.json", ffmpeg="missing")
    except RuntimeError as exc:
        assert "no valid ownership marker" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("unowned fixture files must not be overwritten")


def test_cli_evaluation_smoke_verifies_hashes(tmp_path: Path, monkeypatch) -> None:
    module = _script_module()

    def fake_ffmpeg(_ffmpeg, arguments, label):
        output = Path(arguments[-1])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(f"fixture-{label}".encode("ascii"))

    monkeypatch.setattr(module, "_find_ffmpeg", lambda _explicit: "fake")
    monkeypatch.setattr(module, "_run_ffmpeg", fake_ffmpeg)
    monkeypatch.setattr(module, "_find_ffprobe", lambda _ffmpeg: "fake-ffprobe")
    monkeypatch.setattr(module, "_probe_video", lambda _ffprobe, path: {"width": 320, "height": 180, "fps": 12.0, "duration_seconds": {"short.mp4": 1.5, "speed_2x.mp4": 1.5}.get(path.name, 3.0 if path.name in {"exact.mp4", "mirror.mp4", "crop.mp4"} else 12.0), "frame_count": 18})
    fixture_dir = tmp_path / "fixtures"
    manifest_path = tmp_path / "manifest.json"
    module.generate_fixtures(fixture_dir=fixture_dir, manifest_path=manifest_path, ffmpeg="fake")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    base = (fixture_dir / "base.mp4").resolve()
    exact = (fixture_dir / "exact.mp4").resolve()
    unrelated = (fixture_dir / "unrelated.mp4").resolve()
    report_path = tmp_path / "report.json"
    report_path.write_text(json.dumps({"video_pairs": [
        {"video_a_path": str(base), "video_b_path": str(exact), "relation": "B_is_likely_clip_of_A", "segments": [{"a_start": 3, "a_end": 6, "b_start": 0, "b_end": 3}]},
        {"video_a_path": str(base), "video_b_path": str(unrelated), "relation": "different", "segments": []},
    ]}), encoding="utf-8")
    output_path = tmp_path / "evaluation.json"
    assert module.main(["--manifest", str(manifest_path), "--report", str(report_path), "--output", str(output_path)]) == 0
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["parameters"]["verify_files"] is True
    assert payload["evaluation"]["status"] == "incomplete"


def test_refine_report_is_lazy_and_preserves_input(tmp_path: Path, monkeypatch) -> None:
    module = _script_module()
    left = tmp_path / "a.mp4"
    right = tmp_path / "b.mp4"
    left.write_bytes(b"a")
    right.write_bytes(b"b")
    source = {"video_pairs": [{"video_a_path": str(left), "video_b_path": str(right), "segments": [{"a_start": 0, "a_end": 1, "b_start": 0, "b_end": 1}]}]}
    report_path = tmp_path / "report.json"
    report_path.write_text(json.dumps(source), encoding="utf-8")

    class FakeConfig:
        def __init__(self, mode):
            self.mode = mode

    def fake_refine(video_a, video_b, segments, *, config, preprocess_config, cancel_check):
        assert video_a == str(left)
        assert video_b == str(right)
        assert preprocess_config is None
        assert cancel_check is None
        return {"version": 1, "mode": config.mode, "config": config, "segments": [{"segment_index": 0, "status": "verified", "coarse": segments[0], "proposal": segments[0], "evidence": {}}], "metrics": {}}

    fake_module = types.ModuleType("video_sim.segment_refiner")
    fake_module.RefinementConfig = FakeConfig
    fake_module.refine_segments = fake_refine
    monkeypatch.setitem(sys.modules, "video_sim.segment_refiner", fake_module)
    output_path = tmp_path / "refined.json"
    module.refine_file(report_path, output_path, mode="copy")
    assert json.loads(report_path.read_text(encoding="utf-8")) == source
    refined = json.loads(output_path.read_text(encoding="utf-8"))
    assert refined["video_pairs"][0]["segment_refinement"]["segments"][0]["status"] == "verified"
    assert refined["round4_refinement"]["preprocess_config_source"] == "core_default_missing_input"


def test_refine_off_does_not_invent_refinement_or_overwrite_input(tmp_path: Path) -> None:
    module = _script_module()
    source = {"video_a": "a.mp4", "video_b": "b.mp4", "segments": []}
    report_path = tmp_path / "report.json"
    report_path.write_text(json.dumps(source), encoding="utf-8")
    output_path = tmp_path / "off.json"
    module.refine_file(report_path, output_path, mode="off")
    assert json.loads(output_path.read_text(encoding="utf-8")) == source


def test_fixture_path_guard_rejects_non_direct_child(tmp_path: Path) -> None:
    module = _script_module()
    root = tmp_path / "fixtures"
    spec = [{"path": root / "nested" / "escape.mp4", "id": "escape"}]
    try:
        module._prepare_fixture_dir(root, spec, force=False)
    except RuntimeError as exc:
        assert "escapes fixture directory" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("fixture ownership must be limited to direct children")


def test_json_writer_rejects_non_finite_numbers(tmp_path: Path) -> None:
    module = _script_module()
    with pytest.raises(ValueError, match="JSON compliant"):
        module._write_json(tmp_path / "non-finite.json", {"value": math.nan})
