"""Strict, label-driven evaluation for content-copy recognition reports.

The evaluator is intentionally independent of the recognition algorithm.  It
loads a manifest with explicit labels, normalises either a batch report or a
single pair report, and computes one-to-one interval metrics.  Generated
development fixtures and human holdout annotations use the same schema but
are kept distinguishable in every result.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import os
from typing import Any, Iterable, Mapping


EVALUATION_SCHEMA_VERSION = 1
CONTENT_TYPE = "content_copy"
SPLITS = frozenset({"development", "holdout"})
ANNOTATION_SOURCES = frozenset({"generated", "human"})
RELATIONS = frozenset(
    {
        "near_duplicate_or_same_content",
        "A_is_likely_clip_of_B",
        "B_is_likely_clip_of_A",
        "partial_overlap",
        "different",
    }
)
# These names are the statuses emitted by ``segment_refiner``.  ``not_run``
# and ``abstained`` are also accepted for reports produced by callers that
# explicitly record that no proposal was made; neither status is treated as a
# negative content decision.
REFINEMENT_STATUSES = frozenset(
    {
        "verified",
        "rejected",
        "insufficient_evidence",
        "budget_exceeded",
        "decode_error",
        "not_run",
        "abstained",
    }
)


class EvaluationError(ValueError):
    """Raised when a manifest or report violates the evaluation contract."""


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _finite_nonnegative(value: Any, field: str, *, allow_zero: bool = True) -> float:
    if not _is_number(value):
        raise EvaluationError(f"{field} must be a finite number")
    result = float(value)
    if not math.isfinite(result) or (result < 0.0 if allow_zero else result <= 0.0):
        comparator = "non-negative" if allow_zero else "positive"
        raise EvaluationError(f"{field} must be finite and {comparator}")
    return result


def _required_mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise EvaluationError(f"{field} must be an object")
    return value


def _reject_unknown(value: Mapping[str, Any], allowed: set[str], field: str) -> None:
    unknown = sorted(set(value).difference(allowed))
    if unknown:
        raise EvaluationError(f"{field} contains unknown fields: {unknown}")


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EvaluationError(f"{field} must be a non-empty string")
    return value


def _require_integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise EvaluationError(f"{field} must be an integer")
    return value


def _normalise_relative_path(value: Any, *, manifest_path: Path | None, field: str) -> str:
    raw = _require_string(value, field)
    candidate = Path(raw)
    if candidate.is_absolute() or candidate.drive:
        raise EvaluationError(f"{field} must be relative to the manifest")
    parts = candidate.parts
    if any(part == ".." for part in parts):
        raise EvaluationError(f"{field} must not escape the manifest directory")
    # Store a stable slash-separated spelling, while resolving only when a
    # manifest path is available.  No filename-only matching is performed.
    return candidate.as_posix()


def _manifest_media_path(manifest_path: Path | None, relative: str) -> Path:
    if manifest_path is None:
        return Path(relative).resolve(strict=False)
    return (manifest_path.parent / relative).resolve(strict=False)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _validate_segment(
    value: Any,
    *,
    field: str,
    durations: tuple[float, float],
    require_positive_width: bool,
) -> dict[str, float]:
    segment = _required_mapping(value, field)
    _reject_unknown(segment, {"a_start", "a_end", "b_start", "b_end"}, field)
    result = {
        name: _finite_nonnegative(segment.get(name), f"{field}.{name}")
        for name in ("a_start", "a_end", "b_start", "b_end")
    }
    for start, end, duration, side in (
        (result["a_start"], result["a_end"], durations[0], "a"),
        (result["b_start"], result["b_end"], durations[1], "b"),
    ):
        if end < start or (require_positive_width and end <= start):
            raise EvaluationError(f"{field}.{side} interval has invalid ordering")
        if end > duration + 1e-9:
            raise EvaluationError(f"{field}.{side} interval exceeds video duration")
    return result


def _validate_manifest(
    manifest: Mapping[str, Any],
    *,
    manifest_path: Path | None = None,
    verify_files: bool = False,
) -> dict[str, Any]:
    if not isinstance(manifest, Mapping):
        raise EvaluationError("manifest must be an object")
    _reject_unknown(
        manifest,
        {
            "schema_version",
            "content_type",
            "split",
            "annotation_source",
            "annotation",
            "videos",
            "cases",
        },
        "manifest",
    )
    if _require_integer(manifest.get("schema_version"), "manifest.schema_version") != EVALUATION_SCHEMA_VERSION:
        raise EvaluationError("manifest schema_version is unsupported")
    if manifest.get("content_type") != CONTENT_TYPE:
        raise EvaluationError("manifest content_type must be content_copy")
    split = _require_string(manifest.get("split"), "manifest.split")
    if split not in SPLITS:
        raise EvaluationError(f"manifest.split must be one of {sorted(SPLITS)}")
    annotation_source = _require_string(
        manifest.get("annotation_source"), "manifest.annotation_source"
    )
    if annotation_source not in ANNOTATION_SOURCES:
        raise EvaluationError("manifest.annotation_source must be generated or human")
    annotation = _required_mapping(manifest.get("annotation"), "manifest.annotation")
    if annotation_source == "generated":
        _reject_unknown(annotation, {"generator", "seed", "description"}, "annotation")
        _require_string(annotation.get("generator"), "annotation.generator")
        _require_integer(annotation.get("seed"), "annotation.seed")
    else:
        _reject_unknown(
            annotation,
            {"annotator", "review_status", "provenance", "notes"},
            "annotation",
        )
        _require_string(annotation.get("annotator"), "annotation.annotator")
        _require_string(annotation.get("review_status"), "annotation.review_status")
        _require_string(annotation.get("provenance"), "annotation.provenance")

    videos_value = manifest.get("videos")
    if not isinstance(videos_value, list) or not videos_value:
        raise EvaluationError("manifest.videos must be a non-empty array")
    videos: list[dict[str, Any]] = []
    videos_by_id: dict[str, dict[str, Any]] = {}
    canonical_media_paths: set[str] = set()
    allowed_video_fields = {"id", "path", "duration_seconds", "sha256", "width", "height", "fps", "frame_count"}
    for index, raw_video in enumerate(videos_value):
        video = _required_mapping(raw_video, f"videos[{index}]")
        _reject_unknown(video, allowed_video_fields, f"videos[{index}]")
        video_id = _require_string(video.get("id"), f"videos[{index}].id")
        if video_id in videos_by_id:
            raise EvaluationError(f"duplicate video id: {video_id}")
        relative_path = _normalise_relative_path(
            video.get("path"), manifest_path=manifest_path, field=f"videos[{index}].path"
        )
        canonical_media_key = _path_key(_manifest_media_path(manifest_path, relative_path))
        if canonical_media_key in canonical_media_paths:
            raise EvaluationError(f"duplicate canonical video path: {relative_path}")
        canonical_media_paths.add(canonical_media_key)
        duration = _finite_nonnegative(
            video.get("duration_seconds"), f"videos[{index}].duration_seconds", allow_zero=False
        )
        sha256 = _require_string(video.get("sha256"), f"videos[{index}].sha256").lower()
        if len(sha256) != 64 or any(character not in "0123456789abcdef" for character in sha256):
            raise EvaluationError(f"videos[{index}].sha256 must be a 64-character hexadecimal digest")
        normalised = {
            "id": video_id,
            "path": relative_path,
            "duration_seconds": duration,
            "sha256": sha256,
        }
        for optional in ("width", "height", "fps"):
            if optional in video:
                normalised[optional] = _finite_nonnegative(video[optional], f"videos[{index}].{optional}", allow_zero=False)
        if "frame_count" in video:
            frame_count = _require_integer(video["frame_count"], f"videos[{index}].frame_count")
            if frame_count <= 0:
                raise EvaluationError(f"videos[{index}].frame_count must be positive")
            normalised["frame_count"] = frame_count
        if verify_files:
            media_path = _manifest_media_path(manifest_path, relative_path)
            if not media_path.is_file():
                raise EvaluationError(f"video file does not exist: {media_path}")
            if _sha256_file(media_path) != sha256:
                raise EvaluationError(f"video sha256 does not match manifest: {media_path}")
        videos.append(normalised)
        videos_by_id[video_id] = normalised

    cases_value = manifest.get("cases")
    if not isinstance(cases_value, list) or not cases_value:
        raise EvaluationError("manifest.cases must be a non-empty array")
    cases: list[dict[str, Any]] = []
    case_ids: set[str] = set()
    pair_ids: set[tuple[str, str]] = set()
    allowed_case_fields = {
        "id",
        "video_a",
        "video_b",
        "groups",
        "expected_related",
        "expected_relation",
        "segments",
        "transform",
    }
    for index, raw_case in enumerate(cases_value):
        case = _required_mapping(raw_case, f"cases[{index}]")
        _reject_unknown(case, allowed_case_fields, f"cases[{index}]")
        case_id = _require_string(case.get("id"), f"cases[{index}].id")
        if case_id in case_ids:
            raise EvaluationError(f"duplicate case id: {case_id}")
        video_a = _require_string(case.get("video_a"), f"cases[{index}].video_a")
        video_b = _require_string(case.get("video_b"), f"cases[{index}].video_b")
        if video_a not in videos_by_id or video_b not in videos_by_id:
            raise EvaluationError(f"case {case_id} refers to an unknown video")
        if video_a == video_b:
            raise EvaluationError(f"case {case_id} is a self-pair")
        pair_id = tuple(sorted((video_a, video_b)))
        if pair_id in pair_ids:
            raise EvaluationError(f"duplicate unordered case pair: {pair_id}")
        pair_ids.add(pair_id)
        groups_value = case.get("groups")
        if not isinstance(groups_value, list) or not groups_value or not all(
            isinstance(group, str) and group.strip() for group in groups_value
        ):
            raise EvaluationError(f"case {case_id}.groups must contain non-empty strings")
        groups = list(dict.fromkeys(groups_value))
        if len(groups) != len(groups_value):
            raise EvaluationError(f"case {case_id}.groups must not contain duplicates")
        expected_related = case.get("expected_related")
        if not isinstance(expected_related, bool):
            raise EvaluationError(f"case {case_id}.expected_related must be boolean")
        expected_relation = _require_string(case.get("expected_relation"), f"case {case_id}.expected_relation")
        if expected_relation not in RELATIONS:
            raise EvaluationError(f"case {case_id}.expected_relation is unsupported")
        if expected_related != (expected_relation != "different"):
            raise EvaluationError(f"case {case_id} expected_related disagrees with expected_relation")
        durations = (
            float(videos_by_id[video_a]["duration_seconds"]),
            float(videos_by_id[video_b]["duration_seconds"]),
        )
        raw_segments = case.get("segments")
        if not isinstance(raw_segments, list):
            raise EvaluationError(f"case {case_id}.segments must be an array")
        segments = [
            _validate_segment(
                item,
                field=f"case {case_id}.segments[{segment_index}]",
                durations=durations,
                require_positive_width=True,
            )
            for segment_index, item in enumerate(raw_segments)
        ]
        if expected_related and not segments:
            raise EvaluationError(f"positive case {case_id} must have at least one segment")
        if not expected_related and segments:
            raise EvaluationError(f"negative case {case_id} must not have ground-truth segments")
        normalised_case = {
            "id": case_id,
            "video_a": video_a,
            "video_b": video_b,
            "groups": groups,
            "expected_related": expected_related,
            "expected_relation": expected_relation,
            "segments": segments,
        }
        if "transform" in case:
            transform = _required_mapping(case["transform"], f"case {case_id}.transform")
            normalised_case["transform"] = deepcopy(dict(transform))
        cases.append(normalised_case)
        case_ids.add(case_id)

    return {
        "schema_version": EVALUATION_SCHEMA_VERSION,
        "content_type": CONTENT_TYPE,
        "split": split,
        "annotation_source": annotation_source,
        "annotation": deepcopy(dict(annotation)),
        "videos": videos,
        "cases": cases,
    }


def load_manifest(
    path: str | Path,
    *,
    verify_files: bool = False,
) -> dict[str, Any]:
    """Load and strictly validate a JSON evaluation manifest."""

    manifest_path = Path(path).expanduser().resolve(strict=False)
    try:
        value = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EvaluationError(f"could not read evaluation manifest: {manifest_path}") from exc
    return _validate_manifest(value, manifest_path=manifest_path, verify_files=verify_files)


def validate_manifest(
    manifest: Mapping[str, Any],
    *,
    manifest_path: str | Path | None = None,
    verify_files: bool = False,
) -> dict[str, Any]:
    """Validate an in-memory manifest without mutating the caller's object."""

    resolved = Path(manifest_path).expanduser().resolve(strict=False) if manifest_path else None
    return _validate_manifest(manifest, manifest_path=resolved, verify_files=verify_files)


def _canonical_report_path(
    value: Any,
    *,
    report_path: Path | None,
    field: str,
    report_media_root: Path | None = None,
) -> Path:
    raw = _require_string(value, field)
    path = Path(raw).expanduser()
    # A basename in ``video_a`` is deliberately insufficient.  This avoids
    # assigning a result to a different file with the same filename.
    if not path.is_absolute() and not path.drive:
        if report_media_root is None:
            raise EvaluationError(f"{field} must be absolute, or report_media_root must be explicit")
        path = (report_media_root / path).resolve(strict=False)
        try:
            path.relative_to(report_media_root)
        except ValueError as exc:
            raise EvaluationError(f"{field} escapes report_media_root") from exc
        if not path.is_file():
            raise EvaluationError(f"{field} does not resolve to an existing media file: {path}")
    return path.resolve(strict=False)


def _path_key(path: Path) -> str:
    return os.path.normcase(str(path))


def _report_rows(report: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    if isinstance(report.get("video_pairs"), list):
        return report["video_pairs"]
    if (
        ("video_a_path" in report and "video_b_path" in report)
        or ("video_a" in report and "video_b" in report)
    ):
        return [report]
    if isinstance(report.get("pair"), Mapping):
        return [report["pair"]]
    raise EvaluationError("report must contain video_pairs or one pair with video_a_path/video_b_path")


def _report_segment(
    value: Any,
    *,
    field: str,
    durations: tuple[float, float],
) -> dict[str, float]:
    if not isinstance(value, Mapping):
        raise EvaluationError(f"{field} must be an object")
    if {"a_start", "a_end", "b_start", "b_end"}.issubset(value):
        candidate = {name: value[name] for name in ("a_start", "a_end", "b_start", "b_end")}
    else:
        aliases = {
            "a_start": "source_start",
            "a_end": "source_end",
            "b_start": "target_start",
            "b_end": "target_end",
        }
        if not all(source in value for source in aliases.values()):
            raise EvaluationError(f"{field} must contain four source/target interval values")
        candidate = {target: value[source] for target, source in aliases.items()}
    return _validate_segment(
        candidate,
        field=field,
        durations=durations,
        require_positive_width=False,
    )


def _swap_segment(segment: Mapping[str, float]) -> dict[str, float]:
    return {
        "a_start": float(segment["b_start"]),
        "a_end": float(segment["b_end"]),
        "b_start": float(segment["a_start"]),
        "b_end": float(segment["a_end"]),
    }


def _iou(left_start: float, left_end: float, right_start: float, right_end: float) -> float:
    left = max(0.0, left_end - left_start)
    right = max(0.0, right_end - right_start)
    intersection = max(0.0, min(left_end, right_end) - max(left_start, right_start))
    union = left + right - intersection
    return intersection / union if union > 0.0 else 0.0


def _refinement_views(
    row: Mapping[str, Any],
    coarse: list[dict[str, float]],
    *,
    row_durations: tuple[float, float],
) -> tuple[dict[str, list[dict[str, float]]], dict[str, Any]]:
    raw_refinement = row.get("segment_refinement", row.get("refinement"))
    if raw_refinement is None:
        return (
            {"coarse": list(coarse), "refined": list(coarse), "verified_copy": []},
            {
                "available": False,
                "status": "not_run",
                "verified_indices": [],
                "missing_indices": list(range(len(coarse))),
                "statuses": {},
            },
        )
    if isinstance(raw_refinement, Mapping):
        raw_items = raw_refinement.get("segments")
    else:
        raw_items = raw_refinement
    if not isinstance(raw_items, list):
        raise EvaluationError("segment_refinement.segments must be an array")
    by_index: dict[int, Mapping[str, Any]] = {}
    statuses: dict[str, str] = {}
    for item_index, raw_item in enumerate(raw_items):
        item = _required_mapping(raw_item, f"segment_refinement.segments[{item_index}]")
        _reject_unknown(
            item,
            {"segment_index", "status", "reason", "coarse", "proposal", "evidence", "proposal_adoptable"},
            "segment_refinement item",
        )
        index = item.get("segment_index")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0 or index >= len(coarse):
            raise EvaluationError("segment_refinement segment_index is invalid")
        if index in by_index:
            raise EvaluationError("segment_refinement segment_index is duplicated")
        status = _require_string(item.get("status"), "segment_refinement.status")
        if status not in REFINEMENT_STATUSES:
            raise EvaluationError(f"unsupported segment_refinement status: {status}")
        if "proposal_adoptable" in item and not isinstance(item["proposal_adoptable"], bool):
            raise EvaluationError("segment_refinement.proposal_adoptable must be boolean")
        if status == "verified" and item.get("proposal_adoptable") is False:
            raise EvaluationError("verified segment_refinement item cannot set proposal_adoptable=false")
        if status != "verified" and item.get("proposal_adoptable") is True:
            raise EvaluationError(
                "non-verified segment_refinement item cannot set proposal_adoptable=true"
            )
        if "coarse" in item:
            declared_coarse = _report_segment(
                item["coarse"],
                field=f"segment_refinement[{index}].coarse",
                durations=row_durations,
            )
            if declared_coarse != coarse[index]:
                raise EvaluationError("segment_refinement coarse segment does not match report segment")
        if "proposal" in item and item["proposal"] is not None:
            proposal = _report_segment(
                item["proposal"],
                field=f"segment_refinement[{index}].proposal",
                durations=row_durations,
            )
            item = dict(item)
            item["proposal"] = proposal
        elif status == "verified":
            raise EvaluationError("verified segment_refinement item requires proposal")
        by_index[index] = item
        statuses[str(index)] = status

    refined: list[dict[str, float]] = []
    verified_copy: list[dict[str, float]] = []
    verified_indices: list[int] = []
    missing_indices: list[int] = []
    for index, segment in enumerate(coarse):
        item = by_index.get(index)
        proposal_adoptable = item is not None and item.get("status") == "verified" and item.get("proposal") is not None and item.get("proposal_adoptable", True) is True
        if proposal_adoptable:
            refined.append(dict(item["proposal"]))
            verified_copy.append(dict(item["proposal"]))
            verified_indices.append(index)
        else:
            refined.append(dict(segment))
            missing_indices.append(index)
    return (
        {"coarse": list(coarse), "refined": refined, "verified_copy": verified_copy},
        {
            "available": True,
            "status": "available",
            "verified_indices": verified_indices,
            "missing_indices": missing_indices,
            "statuses": statuses,
        },
    )


def _deterministic_matching(
    predicted: list[dict[str, float]],
    truth: list[dict[str, float]],
    *,
    iou_threshold: float,
) -> list[tuple[int, int, float, float]]:
    """Return a deterministic maximum-cardinality one-to-one matching."""

    candidates: dict[int, list[tuple[int, float, float]]] = {}
    for pred_index, prediction in enumerate(predicted):
        options = []
        for truth_index, expected in enumerate(truth):
            source_iou = _iou(
                prediction["a_start"], prediction["a_end"], expected["a_start"], expected["a_end"]
            )
            target_iou = _iou(
                prediction["b_start"], prediction["b_end"], expected["b_start"], expected["b_end"]
            )
            if source_iou >= iou_threshold and target_iou >= iou_threshold:
                options.append((truth_index, source_iou, target_iou))
        options.sort(key=lambda item: (-min(item[1], item[2]), -(item[1] + item[2]), item[0]))
        candidates[pred_index] = options

    # Kuhn augmenting paths guarantee maximum cardinality.  Candidate and
    # source order are fixed, and each traversal uses the stable score order.
    matched_truth: dict[int, tuple[int, float, float]] = {}

    def visit(pred_index: int, seen: set[int]) -> bool:
        for truth_index, source_iou, target_iou in candidates[pred_index]:
            if truth_index in seen:
                continue
            seen.add(truth_index)
            current = matched_truth.get(truth_index)
            if current is None or visit(current[0], seen):
                matched_truth[truth_index] = (pred_index, source_iou, target_iou)
                return True
        return False

    for pred_index in range(len(predicted)):
        visit(pred_index, set())
    matches = [
        (pred_index, truth_index, source_iou, target_iou)
        for truth_index, (pred_index, source_iou, target_iou) in matched_truth.items()
    ]
    matches.sort(key=lambda item: item[0])
    return matches


def _metrics(counts: Mapping[str, int | None]) -> dict[str, Any]:
    tp = counts.get("tp")
    fp = counts.get("fp")
    fn = counts.get("fn")
    if tp is None or fp is None or fn is None:
        return {"tp": tp, "fp": fp, "fn": fn, "precision": None, "recall": None, "f1": None}
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1_denominator = 2 * tp + fp + fn
    f1 = 2.0 * tp / f1_denominator if f1_denominator else None
    return {
        "tp": int(tp),
        "fp": int(fp),
        "fn": int(fn),
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


def _empty_counts() -> dict[str, int]:
    return {"tp": 0, "fp": 0, "fn": 0}


def _evaluate_view(
    predicted: list[dict[str, float]],
    truth: list[dict[str, float]],
    *,
    expected_related: bool,
    predicted_related: bool,
    iou_threshold: float,
    scoreable: bool = True,
) -> dict[str, Any]:
    if not scoreable:
        return {
            "status": "missing_verification",
            "scoreable": False,
            "predicted_count": len(predicted),
            "ground_truth_count": len(truth),
            "segment_metrics": _metrics({"tp": None, "fp": None, "fn": None}),
            "pair_metrics": _metrics({"tp": None, "fp": None, "fn": None}),
            "negative_fp": None,
            "negative_pair_fp": None,
            "matches": [],
        }
    matches = _deterministic_matching(predicted, truth, iou_threshold=iou_threshold)
    matched_predictions = {item[0] for item in matches}
    matched_truth = {item[1] for item in matches}
    if expected_related:
        segment_counts = {
            "tp": len(matches),
            "fp": len(predicted) - len(matched_predictions),
            "fn": len(truth) - len(matched_truth),
        }
        pair_counts = {
            "tp": int(bool(matches) and predicted_related),
            "fp": 0,
            "fn": int(not (bool(matches) and predicted_related)),
        }
    else:
        segment_counts = {"tp": 0, "fp": len(predicted), "fn": 0}
        pair_counts = {"tp": 0, "fp": int(predicted_related or bool(predicted)), "fn": 0}
    negative_fp = len(predicted) if not expected_related else 0
    negative_pair_fp = pair_counts["fp"] if not expected_related else 0
    match_rows = []
    for pred_index, truth_index, source_iou, target_iou in matches:
        prediction = predicted[pred_index]
        expected = truth[truth_index]
        errors = {
            "a_start": abs(prediction["a_start"] - expected["a_start"]),
            "a_end": abs(prediction["a_end"] - expected["a_end"]),
            "b_start": abs(prediction["b_start"] - expected["b_start"]),
            "b_end": abs(prediction["b_end"] - expected["b_end"]),
        }
        match_rows.append(
            {
                "predicted_index": pred_index,
                "truth_index": truth_index,
                "iou_a": source_iou,
                "iou_b": target_iou,
                "iou_min": min(source_iou, target_iou),
                "iou_mean": (source_iou + target_iou) / 2.0,
                "boundary_error_seconds": errors,
                "boundary_error_mean_seconds": sum(errors.values()) / 4.0,
            }
        )
    return {
        "status": "scored",
        "scoreable": True,
        "predicted_count": len(predicted),
        "ground_truth_count": len(truth),
        "segment_metrics": _metrics(segment_counts),
        "pair_metrics": _metrics(pair_counts),
        "negative_fp": negative_fp,
        "negative_pair_fp": negative_pair_fp,
        "matches": match_rows,
    }


def _aggregate_view(case_results: Iterable[Mapping[str, Any]], view: str) -> dict[str, Any]:
    segment_total = _empty_counts()
    pair_total = _empty_counts()
    negative_fp_total = 0
    negative_pair_fp_total = 0
    matched: list[dict[str, Any]] = []
    unscored: list[str] = []
    for case in case_results:
        result = case["views"][view]
        if not result.get("scoreable"):
            unscored.append(str(case["id"]))
            continue
        for kind, total in (("segment_metrics", segment_total), ("pair_metrics", pair_total)):
            counts = result[kind]
            for name in total:
                total[name] += int(counts[name] or 0)
        negative_fp_total += int(result.get("negative_fp") or 0)
        negative_pair_fp_total += int(result.get("negative_pair_fp") or 0)
        for match in result["matches"]:
            matched.append({"case_id": case["id"], **match})
    boundary_values = [
        value
        for row in matched
        for value in row["boundary_error_seconds"].values()
    ]
    return {
        "segment_metrics": _metrics(segment_total),
        "pair_metrics": _metrics(pair_total),
        "negative_fp": negative_fp_total,
        "negative_pair_fp": negative_pair_fp_total,
        "matched_segment_count": len(matched),
        "matched_segments": matched,
        "boundary_error": {
            "mean_seconds": sum(boundary_values) / len(boundary_values) if boundary_values else None,
            "max_seconds": max(boundary_values) if boundary_values else None,
        },
        "unscored_case_ids": unscored,
    }


def evaluate_report(
    report: Mapping[str, Any] | str | Path,
    manifest: Mapping[str, Any] | str | Path,
    *,
    iou_threshold: float = 0.5,
    allow_extra_pairs: bool = False,
    manifest_path: str | Path | None = None,
    report_media_root: str | Path | None = None,
) -> dict[str, Any]:
    """Evaluate a report against explicit four-boundary interval labels.

    ``coarse`` contains the report's original ``segments``.  ``refined``
    substitutes only verified refinement proposals and retains coarse
    segments for every other status.  ``verified_copy`` contains only verified
    proposals and marks cases without verification as unscored.
    """

    threshold = _finite_nonnegative(iou_threshold, "iou_threshold", allow_zero=False)
    if threshold > 1.0:
        raise EvaluationError("iou_threshold must be at most 1")
    if isinstance(manifest, (str, Path)):
        manifest_value = load_manifest(manifest)
        resolved_manifest_path = Path(manifest).expanduser().resolve(strict=False)
    else:
        resolved_manifest_path = (
            Path(manifest_path).expanduser().resolve(strict=False) if manifest_path else None
        )
        manifest_value = validate_manifest(manifest, manifest_path=resolved_manifest_path)
    resolved_report_media_root = (
        Path(report_media_root).expanduser().resolve(strict=False)
        if report_media_root is not None
        else None
    )
    if isinstance(report, (str, Path)):
        report_path = Path(report).expanduser().resolve(strict=False)
        try:
            report_value = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise EvaluationError(f"could not read recognition report: {report_path}") from exc
    else:
        report_path = None
        report_value = report
    report_value = _required_mapping(report_value, "report")

    video_by_id = {video["id"]: video for video in manifest_value["videos"]}
    path_to_video = {
        _path_key(_manifest_media_path(resolved_manifest_path, video["path"])): video["id"]
        for video in manifest_value["videos"]
    }
    case_by_pair = {
        frozenset((case["video_a"], case["video_b"])): case
        for case in manifest_value["cases"]
    }
    rows = _report_rows(report_value)
    if not all(isinstance(row, Mapping) for row in rows):
        raise EvaluationError("report pair rows must be objects")
    found: dict[str, tuple[Mapping[str, Any], bool]] = {}
    extras: list[dict[str, str]] = []
    for row_index, row in enumerate(rows):
        left_value = row.get("video_a_path", row.get("video_a"))
        right_value = row.get("video_b_path", row.get("video_b"))
        has_path_pair = "video_a_path" in row and "video_b_path" in row
        has_named_pair = "video_a" in row and "video_b" in row
        if not (has_path_pair or has_named_pair):
            # A report row with only names is not safe to align.  Even if a
            # name happens to be unique today, that would be filename guessing.
            raise EvaluationError(f"report pair {row_index} lacks complete video paths")
        left_path = _canonical_report_path(
            left_value,
            report_path=report_path,
            field=f"report[{row_index}].video_a_path",
            report_media_root=resolved_report_media_root,
        )
        right_path = _canonical_report_path(
            right_value,
            report_path=report_path,
            field=f"report[{row_index}].video_b_path",
            report_media_root=resolved_report_media_root,
        )
        left_id = path_to_video.get(_path_key(left_path))
        right_id = path_to_video.get(_path_key(right_path))
        if left_id is None or right_id is None:
            if allow_extra_pairs:
                extras.append({"video_a": str(left_path), "video_b": str(right_path)})
                continue
            raise EvaluationError(f"report pair {row_index} is not present in the evaluation manifest")
        case = case_by_pair.get(frozenset((left_id, right_id)))
        if case is None:
            if allow_extra_pairs:
                extras.append({"video_a": left_id, "video_b": right_id})
                continue
            raise EvaluationError(f"report pair {row_index} is not present in the evaluation manifest")
        key = case["id"]
        if key in found:
            raise EvaluationError(f"report contains duplicate evaluation case: {key}")
        reversed_orientation = (left_id, right_id) != (case["video_a"], case["video_b"])
        found[key] = (row, reversed_orientation)

    case_results: list[dict[str, Any]] = []
    for case in manifest_value["cases"]:
        row_info = found.get(case["id"])
        expected_durations = (
            float(video_by_id[case["video_a"]]["duration_seconds"]),
            float(video_by_id[case["video_b"]]["duration_seconds"]),
        )
        if row_info is None:
            views = {
                view: _evaluate_view(
                    [],
                    case["segments"],
                    expected_related=case["expected_related"],
                    predicted_related=False,
                    iou_threshold=threshold,
                )
                for view in ("coarse", "refined", "verified_copy")
            }
            case_results.append(
                {
                    "id": case["id"],
                    "groups": list(case["groups"]),
                    "status": "missing_case",
                    "orientation": None,
                    "relation": None,
                    "expected_related": case["expected_related"],
                    "views": views,
                    "refinement": {
                        "available": False,
                        "status": "missing_case",
                        "missing_indices": list(range(len(case["segments"]))),
                        "verified_indices": [],
                        "statuses": {},
                    },
                }
            )
            continue

        row, reversed_orientation = row_info
        row_video_ids = (case["video_b"], case["video_a"]) if reversed_orientation else (case["video_a"], case["video_b"])
        row_durations = (
            float(video_by_id[row_video_ids[0]]["duration_seconds"]),
            float(video_by_id[row_video_ids[1]]["duration_seconds"]),
        )
        raw_segments = row.get("segments", [])
        if not isinstance(raw_segments, list):
            raise EvaluationError(f"report case {case['id']}.segments must be an array")
        raw_relation = row.get("relation")
        relation = "different" if raw_relation is None else _require_string(raw_relation, f"report case {case['id']}.relation")
        if relation not in RELATIONS:
            raise EvaluationError(f"report case {case['id']}.relation is unsupported")
        row_coarse = [
            _report_segment(item, field=f"report case {case['id']}.segments[{index}]", durations=row_durations)
            for index, item in enumerate(raw_segments)
        ]
        coarse = [_swap_segment(item) for item in row_coarse] if reversed_orientation else row_coarse
        views_row, refinement = _refinement_views(row, row_coarse, row_durations=row_durations)
        views = {}
        verified_predicted_related = bool(refinement["verified_indices"])
        for view, values in views_row.items():
            oriented = [_swap_segment(item) for item in values] if reversed_orientation else values
            predicted_related = (
                verified_predicted_related if view == "verified_copy"
                else relation != "different"
            )
            views[view] = _evaluate_view(
                oriented,
                case["segments"],
                expected_related=case["expected_related"],
                predicted_related=predicted_related,
                iou_threshold=threshold,
            )
        case_results.append(
            {
                "id": case["id"],
                "groups": list(case["groups"]),
                "status": "scored",
                "orientation": "reversed" if reversed_orientation else "forward",
                "relation": relation,
                "expected_related": case["expected_related"],
                "predicted_related": relation != "different",
                "coarse_segments": coarse,
                "views": views,
                "refinement": refinement,
            }
        )

    by_group: dict[str, dict[str, Any]] = {}
    for group in sorted({group for case in case_results for group in case["groups"]}):
        by_group[group] = {
            view: _aggregate_view([case for case in case_results if group in case["groups"]], view)
            for view in ("coarse", "refined", "verified_copy")
        }
    status = "complete" if not any(case["status"] == "missing_case" for case in case_results) else "incomplete"
    aggregate_views = {
        view: _aggregate_view(case_results, view)
        for view in ("coarse", "refined", "verified_copy")
    }
    verified_available = any(
        case["refinement"].get("available") for case in case_results
    )
    non_verified_statuses = {
        "rejected",
        "insufficient_evidence",
        "budget_exceeded",
        "decode_error",
        "abstained",
        "not_run",
    }
    non_verified_case_ids = [
        case["id"]
        for case in case_results
        if any(
            status in non_verified_statuses
            for status in case["refinement"].get("statuses", {}).values()
        )
    ]
    aggregate_views["verified_copy"].update(
        {
            "available": verified_available,
            "status": "available" if verified_available else "not_run",
            "not_run_case_ids": [
                case["id"]
                for case in case_results
                if case["refinement"].get("status") in {"not_run", "missing_case"}
            ],
            "abstained_case_ids": [
                *non_verified_case_ids,
            ],
            "non_verified_case_ids": non_verified_case_ids,
        }
    )
    return {
        "schema_version": "recognition-evaluation-result-v1",
        "status": status,
        "accuracy_available": True,
        "manifest": {
            "schema_version": manifest_value["schema_version"],
            "split": manifest_value["split"],
            "annotation_source": manifest_value["annotation_source"],
            "content_type": manifest_value["content_type"],
        },
        "parameters": {
            "iou_threshold_both_sides": threshold,
            "report_media_root": str(resolved_report_media_root) if resolved_report_media_root else None,
            "interval_convention": "half-open [start, end)",
            "matching": "deterministic maximum-cardinality one-to-one; duplicate predictions cannot reuse a truth segment",
        },
        "views": aggregate_views,
        "groups": by_group,
        "cases": case_results,
        "coverage": {
            "manifest_cases": len(manifest_value["cases"]),
            "report_rows": len(rows),
            "matched_cases": len(found),
            "missing_case_ids": [case["id"] for case in case_results if case["status"] == "missing_case"],
            "ignored_extra_pairs": extras,
        },
        "limitations": [
            "The evaluator scores only explicit manifest labels; filenames and model output never create labels.",
            "Generated fixtures are development evidence and are not a human holdout or a claim about user-library accuracy.",
            "verified_copy counts every labelled case; absent, not_run, and abstained proposals contribute empty predictions and are never treated as unrelated.",
        ],
    }


__all__ = [
    "CONTENT_TYPE",
    "EVALUATION_SCHEMA_VERSION",
    "EvaluationError",
    "evaluate_report",
    "load_manifest",
    "validate_manifest",
]
