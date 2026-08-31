from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil

import pytest

from video_sim.evaluation import EvaluationError, evaluate_report, load_manifest, validate_manifest
from video_sim.evaluation import _deterministic_matching


def _manifest(tmp_path: Path, *, two_truth_segments: bool = False) -> tuple[Path, dict]:
    paths = {}
    for name in ("a", "b", "c"):
        path = tmp_path / f"{name}.mp4"
        path.write_bytes(name.encode("ascii"))
        paths[name] = path
    videos = [
        {"id": name, "path": f"{name}.mp4", "duration_seconds": 30.0, "sha256": hashlib.sha256(paths[name].read_bytes()).hexdigest()}
        for name in paths
    ]
    truth = [{"a_start": 2.0, "a_end": 6.0, "b_start": 0.0, "b_end": 4.0}]
    if two_truth_segments:
        truth.append({"a_start": 10.0, "a_end": 14.0, "b_start": 10.0, "b_end": 14.0})
    manifest = {
        "schema_version": 1,
        "content_type": "content_copy",
        "split": "development",
        "annotation_source": "generated",
        "annotation": {"generator": "test", "seed": 20260831, "description": "unit fixture"},
        "videos": videos,
        "cases": [
            {
                "id": "positive",
                "video_a": "a",
                "video_b": "b",
                "groups": ["exact"],
                "expected_related": True,
                "expected_relation": "B_is_likely_clip_of_A",
                "segments": truth,
            },
            {
                "id": "negative",
                "video_a": "a",
                "video_b": "c",
                "groups": ["unrelated"],
                "expected_related": False,
                "expected_relation": "different",
                "segments": [],
            },
        ],
    }
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path, manifest


def _pair(path_a: Path, path_b: Path, segments: list[dict], **extra) -> dict:
    row = {"video_a_path": str(path_a.resolve()), "video_b_path": str(path_b.resolve()), "segments": segments}
    row.update(extra)
    return row


def test_maximum_cardinality_matching_beats_greedy_choice() -> None:
    truth = [
        {"a_start": 0.0, "a_end": 10.0, "b_start": 0.0, "b_end": 10.0},
        {"a_start": 10.0, "a_end": 20.0, "b_start": 10.0, "b_end": 20.0},
    ]
    predicted = [
        {"a_start": 0.0, "a_end": 20.0, "b_start": 0.0, "b_end": 20.0},
        {"a_start": 0.0, "a_end": 10.0, "b_start": 0.0, "b_end": 10.0},
    ]
    matches = _deterministic_matching(predicted, truth, iou_threshold=0.5)
    assert len(matches) == 2
    assert {(pred, expected) for pred, expected, *_ in matches} == {(0, 1), (1, 0)}


def test_both_sides_iou_threshold_is_required(tmp_path: Path) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    report = {"video_pairs": [_pair(tmp_path / "a.mp4", tmp_path / "b.mp4", [{"a_start": 2, "a_end": 6, "b_start": 0, "b_end": 1.6}], relation="B_is_likely_clip_of_A"), _pair(tmp_path / "a.mp4", tmp_path / "c.mp4", [], relation="different")]}
    result = evaluate_report(report, manifest_path)
    metrics = result["cases"][0]["views"]["coarse"]["segment_metrics"]
    assert metrics["tp"] == 0 and metrics["fp"] == 1 and metrics["fn"] == 1
    assert metrics["f1"] == 0


def test_duplicate_predictions_only_one_can_match(tmp_path: Path) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    segment = {"a_start": 2, "a_end": 6, "b_start": 0, "b_end": 4}
    report = {"video_pairs": [_pair(tmp_path / "a.mp4", tmp_path / "b.mp4", [segment, dict(segment)], relation="B_is_likely_clip_of_A"), _pair(tmp_path / "a.mp4", tmp_path / "c.mp4", [], relation="different")]}
    result = evaluate_report(report, manifest_path)
    metrics = result["cases"][0]["views"]["coarse"]["segment_metrics"]
    assert metrics["tp"] == 1 and metrics["fp"] == 1 and metrics["fn"] == 0


def test_reverse_pair_swaps_interval_orientation_and_accepts_single_report(tmp_path: Path) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    report = {"video_a": str((tmp_path / "b.mp4").resolve()), "video_b": str((tmp_path / "a.mp4").resolve()), "segments": [{"a_start": 0, "a_end": 4, "b_start": 2, "b_end": 6}], "relation": "A_is_likely_clip_of_B"}
    report_before = deepcopy(report)
    result = evaluate_report(report, manifest_path)
    assert result["cases"][0]["orientation"] == "reversed"
    assert result["cases"][0]["views"]["coarse"]["segment_metrics"]["tp"] == 1
    assert report == report_before


def test_missing_case_is_incomplete_and_verified_copy_keeps_denominator(tmp_path: Path) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    report = {"video_pairs": [_pair(tmp_path / "a.mp4", tmp_path / "b.mp4", [{"a_start": 2, "a_end": 6, "b_start": 0, "b_end": 4}], relation="B_is_likely_clip_of_A")]}
    result = evaluate_report(report, manifest_path)
    assert result["status"] == "incomplete"
    assert result["coverage"]["missing_case_ids"] == ["negative"]
    assert result["views"]["verified_copy"]["status"] == "not_run"
    assert result["views"]["verified_copy"]["available"] is False
    assert result["views"]["verified_copy"]["pair_metrics"]["fn"] == 1


def test_verified_refinement_replaces_only_verified_proposal_and_does_not_mutate_input(tmp_path: Path) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    # Use a valid coarse interval and a slightly better proposal.
    coarse = {"a_start": 2.0, "a_end": 6.0, "b_start": 0.0, "b_end": 4.0}
    report = {"video_pairs": [_pair(tmp_path / "a.mp4", tmp_path / "b.mp4", [coarse], relation="B_is_likely_clip_of_A", segment_refinement={"segments": [{"segment_index": 0, "status": "verified", "coarse": coarse, "proposal": {"a_start": 2.1, "a_end": 5.9, "b_start": 0.1, "b_end": 3.9}, "evidence": {"support": 4}}]}), _pair(tmp_path / "a.mp4", tmp_path / "c.mp4", [], relation="different")]}
    before = deepcopy(report)
    result = evaluate_report(report, manifest_path)
    assert report == before
    case = result["cases"][0]
    assert case["views"]["refined"]["segment_metrics"]["tp"] == 1
    assert case["views"]["verified_copy"]["segment_metrics"]["tp"] == 1
    assert result["views"]["verified_copy"]["available"] is True


def test_verified_copy_without_refinement_scores_empty_predictions(tmp_path: Path) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    report = {"video_pairs": [_pair(tmp_path / "a.mp4", tmp_path / "b.mp4", [], relation="different"), _pair(tmp_path / "a.mp4", tmp_path / "c.mp4", [], relation="different")]}
    result = evaluate_report(report, manifest_path)
    view = result["views"]["verified_copy"]
    assert view["available"] is False
    assert view["segment_metrics"]["tp"] == 0
    assert view["segment_metrics"]["fn"] == 1
    assert view["pair_metrics"]["fn"] == 1


@pytest.mark.parametrize("status", ["rejected", "insufficient_evidence", "budget_exceeded", "decode_error", "abstained", "not_run"])
def test_core_refinement_statuses_keep_nonverified_case_in_denominator(tmp_path: Path, status: str) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    coarse = {"a_start": 2, "a_end": 6, "b_start": 0, "b_end": 4}
    report = {"video_pairs": [_pair(tmp_path / "a.mp4", tmp_path / "b.mp4", [coarse], relation="B_is_likely_clip_of_A", segment_refinement={"segments": [{"segment_index": 0, "status": status, "coarse": coarse}]}), _pair(tmp_path / "a.mp4", tmp_path / "c.mp4", [], relation="different")]}
    result = evaluate_report(report, manifest_path)
    assert result["views"]["verified_copy"]["segment_metrics"]["fn"] == 1
    assert "positive" in result["views"]["verified_copy"]["abstained_case_ids"]


def test_proposal_adoptable_flag_controls_v2_refinement_mapping(tmp_path: Path) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    coarse = {"a_start": 2, "a_end": 6, "b_start": 0, "b_end": 4}
    rejected = {"a_start": 15.0, "a_end": 19.0, "b_start": 15.0, "b_end": 19.0}
    report = {"video_pairs": [_pair(tmp_path / "a.mp4", tmp_path / "b.mp4", [coarse], relation="B_is_likely_clip_of_A", segment_refinement={"version": "segment-refiner-v2", "segments": [{"segment_index": 0, "status": "rejected", "proposal_adoptable": False, "coarse": coarse, "proposal": rejected}]}), _pair(tmp_path / "a.mp4", tmp_path / "c.mp4", [], relation="different")]}
    result = evaluate_report(report, manifest_path)
    assert len(result["cases"][0]["views"]["refined"]["matches"]) == 1
    assert result["cases"][0]["views"]["verified_copy"]["matches"] == []
    contradictory = deepcopy(report)
    contradictory["video_pairs"][0]["segment_refinement"]["segments"][0].update(proposal_adoptable=True)
    with pytest.raises(EvaluationError, match="proposal_adoptable"):
        evaluate_report(contradictory, manifest_path)
    contradictory = deepcopy(report)
    contradictory["video_pairs"][0]["segment_refinement"]["segments"][0].update(status="verified", proposal_adoptable=False)
    with pytest.raises(EvaluationError, match="proposal_adoptable"):
        evaluate_report(contradictory, manifest_path)


def test_zero_denominator_is_null(tmp_path: Path) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    report = {"video_pairs": [_pair(tmp_path / "a.mp4", tmp_path / "c.mp4", [], relation="different"), _pair(tmp_path / "a.mp4", tmp_path / "b.mp4", [], relation="different")]}
    result = evaluate_report(report, manifest_path)
    metrics = result["cases"][0]["views"]["coarse"]["pair_metrics"]
    assert metrics["tp"] == 0 and metrics["fp"] == 0 and metrics["fn"] == 1
    negative_metrics = result["cases"][1]["views"]["coarse"]["pair_metrics"]
    assert negative_metrics["precision"] is None and negative_metrics["recall"] is None


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value.update(schema_version=True),
        lambda value: value["annotation"].update(seed=float("nan")),
        lambda value: value["videos"].append(dict(value["videos"][0], id="alias")),
        lambda value: value.update(cases=[dict(value["cases"][0], video_b="a")]),
    ],
)
def test_bad_manifest_schema_is_rejected(tmp_path: Path, mutate) -> None:
    _, manifest = _manifest(tmp_path)
    broken = deepcopy(manifest)
    mutate(broken)
    with pytest.raises(EvaluationError):
        validate_manifest(broken)


def test_root_manifest_must_be_mapping_and_zero_threshold_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(EvaluationError):
        validate_manifest([])  # type: ignore[arg-type]
    manifest_path, manifest = _manifest(tmp_path)
    report = {"video_pairs": [_pair(tmp_path / "a.mp4", tmp_path / "b.mp4", [], relation="different"), _pair(tmp_path / "a.mp4", tmp_path / "c.mp4", [], relation="different")]}
    with pytest.raises(EvaluationError, match="iou_threshold"):
        evaluate_report(report, manifest_path, iou_threshold=0)


def test_only_basename_report_paths_are_rejected(tmp_path: Path) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    report = {"video_pairs": [{"video_a_path": "a.mp4", "video_b_path": "b.mp4", "segments": []}, _pair(tmp_path / "a.mp4", tmp_path / "c.mp4", [], relation="different")]}
    with pytest.raises(EvaluationError, match="absolute"):
        evaluate_report(report, manifest_path)


def test_relative_batch_paths_require_explicit_media_root(tmp_path: Path) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    media = tmp_path / "media"
    media.mkdir()
    for name in ("a", "b", "c"):
        shutil.move(str(tmp_path / f"{name}.mp4"), str(media / f"{name}.mp4"))
    for video in manifest["videos"]:
        video["path"] = f"media/{video['id']}.mp4"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    report = {"video_pairs": [
        {"video_a_path": "media/a.mp4", "video_b_path": "media/b.mp4", "segments": [{"a_start": 2, "a_end": 6, "b_start": 0, "b_end": 4}], "relation": "B_is_likely_clip_of_A"},
        {"video_a_path": "media/a.mp4", "video_b_path": "media/c.mp4", "segments": [], "relation": "different"},
    ]}
    with pytest.raises(EvaluationError, match="report_media_root"):
        evaluate_report(report, manifest_path)
    result = evaluate_report(report, manifest_path, report_media_root=tmp_path)
    assert result["cases"][0]["views"]["coarse"]["segment_metrics"]["tp"] == 1


def test_report_media_root_does_not_search_same_named_files(tmp_path: Path) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    (first / "a.mp4").write_bytes(b"first-a")
    (second / "a.mp4").write_bytes(b"second-a")
    # The explicit root resolves exactly the requested relative path; it does
    # not search either directory for a basename match.
    report = {"video_pairs": [{"video_a_path": "first/a.mp4", "video_b_path": str((tmp_path / "b.mp4").resolve()), "segments": []}, _pair(tmp_path / "a.mp4", tmp_path / "c.mp4", [], relation="different")]}
    with pytest.raises(EvaluationError, match="not present"):
        evaluate_report(report, manifest_path, report_media_root=tmp_path)


def test_load_manifest_can_verify_media_hashes(tmp_path: Path) -> None:
    manifest_path, manifest = _manifest(tmp_path)
    assert load_manifest(manifest_path, verify_files=True)["videos"][0]["id"] == "a"
    (tmp_path / "a.mp4").write_bytes(b"changed")
    with pytest.raises(EvaluationError, match="sha256"):
        load_manifest(manifest_path, verify_files=True)
