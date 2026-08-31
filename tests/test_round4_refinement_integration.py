"""Fast integration seams for the optional round four segment verifier."""

from __future__ import annotations

import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import batch_compare, compare_two
from video_sim.recognition_contract import pair_parameters
from video_sim.segment_refiner import RefinementConfig


def _args(*, refinement: RefinementConfig | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        match_threshold=0.65,
        window_size=30.0,
        top_k=10,
        min_segment_duration=5.0,
        min_segment_matches=3,
        offset_tolerance=3.0,
        disable_early_stop=False,
        _segment_refinement_config=refinement,
    )


def _coarse_segment() -> dict:
    return {
        "source_start": 1.0,
        "source_end": 4.0,
        "target_start": 10.0,
        "target_end": 13.0,
        "coverage": 0.8,
        "avg_similarity": 0.97,
        "confidence": 0.9,
        "match_count": 12,
    }


def _fake_runtime_modules(monkeypatch: pytest.MonkeyPatch) -> None:
    embedder = types.ModuleType("video_sim.embedder")
    embedder.FRAME_CACHE_SCHEMA_VERSION = 4
    embedder.embedding_runtime_fingerprint = lambda device: f"test:{device}"
    locator = types.ModuleType("video_sim.model_locator")
    locator.embedding_model_fingerprint = lambda: "test-model"
    monkeypatch.setitem(sys.modules, "video_sim.embedder", embedder)
    monkeypatch.setitem(sys.modules, "video_sim.model_locator", locator)


def test_default_off_keeps_resume_signature_and_pair_key_semantics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The opt-in verifier must not alter the legacy off identity or payload."""

    _fake_runtime_modules(monkeypatch)
    video_a = tmp_path / "a.mp4"
    video_b = tmp_path / "b.mp4"
    video_a.write_bytes(b"a")
    video_b.write_bytes(b"b")

    base = _args()
    off = _args(refinement=RefinementConfig())
    base_signature = batch_compare.build_resume_signature([], base, None, "cpu")
    off_signature = batch_compare.build_resume_signature([], off, None, "cpu")

    assert "segment_refinement_config" not in base_signature
    assert off_signature == base_signature
    assert pair_parameters(off_signature) == pair_parameters(base_signature)
    assert batch_compare.pair_result_key(
        video_a,
        video_b,
        resume_signature=off_signature,
    ) == batch_compare.pair_result_key(
        video_a,
        video_b,
        resume_signature=base_signature,
    )
    payload, error = batch_compare.refine_pair_segments_with_fallback(
        video_a,
        video_b,
        [_coarse_segment()],
        config=RefinementConfig(),
    )
    assert payload is None
    assert error is None


def test_enabled_refinement_config_is_complete_and_enters_pair_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_runtime_modules(monkeypatch)
    video_a = tmp_path / "a.mp4"
    video_b = tmp_path / "b.mp4"
    video_a.write_bytes(b"a")
    video_b.write_bytes(b"b")

    config = RefinementConfig(
        mode="copy-mirror",
        sample_step_sec=0.5,
        padding_sec=0.25,
        search_radius_sec=0.75,
        max_segments=2,
        max_frames=128,
        max_wall_sec=3.0,
        max_frame_pixels=12345,
        pixel_threshold=0.95,
        min_support=4,
        min_temporal_change=0.1,
    )
    signature = batch_compare.build_resume_signature(
        [], _args(refinement=config), None, "cpu"
    )
    assert signature["segment_refinement_config"] == config.to_dict()
    assert "segment_refinement_config" in pair_parameters(signature)

    changed = RefinementConfig(mode="copy-mirror", pixel_threshold=0.96)
    changed_signature = batch_compare.build_resume_signature(
        [], _args(refinement=changed), None, "cpu"
    )
    assert batch_compare.pair_result_key(
        video_a, video_b, resume_signature=signature
    ) != batch_compare.pair_result_key(
        video_a, video_b, resume_signature=changed_signature
    )


def test_batch_refinement_error_preserves_coarse_and_is_structured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = RefinementConfig(mode="copy")

    def fail(*_args, **_kwargs):
        raise OSError("decoder unavailable")

    monkeypatch.setattr("video_sim.segment_refiner.refine_segments", fail)
    payload, error = batch_compare.refine_pair_segments_with_fallback(
        "a.mp4", "b.mp4", [_coarse_segment()], config=config
    )

    assert isinstance(error, OSError)
    assert payload["version"] == "segment-refiner-v2"
    assert payload["mode"] == "copy"
    assert payload["metrics"]["error"].startswith("OSError:")
    assert payload["segments"] == [
        {
            "segment_index": 0,
            "status": "decode_error",
            "reason": "refinement_error:OSError:decoder unavailable",
            "coarse": _coarse_segment(),
            "proposal": None,
            "evidence": {},
        }
    ]


def test_batch_analysis_cancelled_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    config = RefinementConfig(mode="copy")

    def cancel(*_args, **_kwargs):
        raise batch_compare.AnalysisCancelled("cancelled")

    monkeypatch.setattr("video_sim.segment_refiner.refine_segments", cancel)
    with pytest.raises(batch_compare.AnalysisCancelled, match="cancelled"):
        batch_compare.refine_pair_segments_with_fallback(
            "a.mp4", "b.mp4", [_coarse_segment()], config=config
        )


def test_single_report_refinement_error_preserves_coarse_and_is_structured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = RefinementConfig(mode="copy")

    def fail(*_args, **_kwargs):
        raise RuntimeError("optional verifier failed")

    monkeypatch.setattr(compare_two, "refine_segments", fail)
    payload, error = compare_two.refine_pair_segments_with_fallback(
        "a.mp4", "b.mp4", [_coarse_segment()], config=config
    )

    assert isinstance(error, RuntimeError)
    assert payload["mode"] == "copy"
    assert payload["metrics"]["error"].startswith("RuntimeError:")
    assert payload["segments"][0]["status"] == "decode_error"
    assert payload["segments"][0]["coarse"] == _coarse_segment()
    assert payload["segments"][0]["proposal"] is None
