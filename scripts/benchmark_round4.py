#!/usr/bin/env python3
"""Generate local evaluation fixtures and run the round-four evaluator.

The fixture labels are written from the construction recipe before any
recognition report is read.  This script never downloads a model or media.  A
separate ``--refine-report`` mode lazily imports the in-repository refinement
core so that evaluation-only runs remain usable while that core evolves.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import asdict, is_dataclass
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SEED = 20260831
DEFAULT_FIXTURE_DIR = ROOT / "data" / "upgrade_round4_20260831" / "fixtures"
DEFAULT_MANIFEST = ROOT / "data" / "upgrade_round4_20260831" / "recognition-evaluation-manifest.json"
DEFAULT_EVALUATION = ROOT / "data" / "upgrade_round4_20260831" / "evaluation.json"
DEFAULT_REFINED = ROOT / "data" / "upgrade_round4_20260831" / "refined-report.json"
MARKER_NAME = ".round4-fixtures.json"


def _json_default(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "item"):
        return value.item()
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    if is_dataclass(value):
        return asdict(value)
    if hasattr(value, "__dict__"):
        return vars(value)
    raise TypeError(f"value is not JSON serializable: {type(value).__name__}")


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            default=_json_default,
            allow_nan=False,
        )
        + "\n",
        encoding="utf-8",
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _git_source() -> dict[str, Any]:
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout
        return {"sha": sha, "working_tree_dirty": bool(status.strip())}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"sha": None, "working_tree_dirty": None, "error": str(exc)}


def _find_ffmpeg(explicit: str | None) -> str:
    candidates = [explicit, os.environ.get("VIDEO_SIM_FFMPEG"), shutil.which("ffmpeg")]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise RuntimeError("ffmpeg was not found; pass --ffmpeg or set VIDEO_SIM_FFMPEG")


def _find_ffprobe(ffmpeg: str | None = None) -> str:
    candidates = [os.environ.get("VIDEO_SIM_FFPROBE"), shutil.which("ffprobe")]
    if ffmpeg:
        ffmpeg_path = Path(ffmpeg)
        candidates.extend(
            str(ffmpeg_path.with_name(name))
            for name in ("ffprobe.exe", "ffprobe")
        )
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise RuntimeError("ffprobe was not found; set VIDEO_SIM_FFPROBE")


def _run_ffmpeg(ffmpeg: str, arguments: list[str], label: str) -> None:
    completed = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *arguments],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if completed.returncode:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"ffmpeg failed while creating {label}: {detail}")


def _encode_args(input_args: list[str], output: Path, *, filters: str | None = None, output_duration: float | None = None) -> list[str]:
    args = list(input_args)
    if filters:
        args += ["-vf", filters]
    if output_duration is not None:
        args += ["-t", str(output_duration)]
    args += [
        "-r",
        "12",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-an",
        str(output),
    ]
    return args


def _fixture_specs(base: Path, root: Path) -> list[dict[str, Any]]:
    """Return deterministic output recipes and construction labels."""

    trim = ["-ss", "3", "-t", "3", "-i", str(base)]
    return [
        {
            "id": "base",
            "path": base,
            "duration_seconds": 12.0,
            "source": "lavfi testsrc2 320x180@12fps (independent deterministic source)",
            "input": ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=12"],
            "filters": None,
        },
        {
            "id": "exact",
            "path": root / "exact.mp4",
            "duration_seconds": 3.0,
            "source": "trim base [3,6)",
            "input": trim,
            "filters": None,
        },
        {
            "id": "short",
            "path": root / "short.mp4",
            "duration_seconds": 1.5,
            "source": "trim base [4,5.5)",
            "input": ["-ss", "4", "-t", "1.5", "-i", str(base)],
            "filters": None,
        },
        {
            "id": "mirror",
            "path": root / "mirror.mp4",
            "duration_seconds": 3.0,
            "source": "trim base [3,6), horizontal mirror",
            "input": trim,
            "filters": "hflip",
        },
        {
            "id": "crop",
            "path": root / "crop.mp4",
            "duration_seconds": 3.0,
            "source": "trim base [3,6), crop [20,10,280,160] and resize to 320x180",
            "input": trim,
            "filters": "crop=280:160:20:10,scale=320:180",
        },
        {
            "id": "speed_2x",
            "path": root / "speed_2x.mp4",
            "duration_seconds": 1.5,
            "source": "trim base [3,6), setpts=PTS/2",
            "input": trim,
            "filters": "setpts=PTS/2,trim=duration=1.5,setpts=PTS-STARTPTS",
            "output_duration": 1.5,
        },
        {
            "id": "unrelated",
            "path": root / "unrelated.mp4",
            "duration_seconds": 12.0,
            "source": "independent lavfi smptebars pattern; no shared clip",
            "input": ["-f", "lavfi", "-i", "smptebars=size=320x180:rate=12:duration=12"],
            "filters": "hue=h=137:s=0.25",
        },
        {
            "id": "static_template",
            "path": root / "static_template.mp4",
            "duration_seconds": 12.0,
            "source": "constant gray canvas with fixed border and blue content block",
            "input": ["-f", "lavfi", "-i", "color=c=0x777777:size=320x180:rate=12:duration=12"],
            "filters": "drawbox=x=12:y=12:w=296:h=156:color=white:t=4,drawbox=x=96:y=48:w=128:h=84:color=blue:t=fill",
        },
        {
            "id": "static_variant",
            "path": root / "static_variant.mp4",
            "duration_seconds": 12.0,
            "source": "same fixed border template but green content block; negative pair",
            "input": ["-f", "lavfi", "-i", "color=c=0x777777:size=320x180:rate=12:duration=12"],
            "filters": "drawbox=x=12:y=12:w=296:h=156:color=white:t=4,drawbox=x=96:y=48:w=128:h=84:color=green:t=fill",
        },
    ]


def _validate_marker(marker: Path, specs: list[dict[str, Any]]) -> dict[str, Any]:
    try:
        value = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"invalid round-four fixture ownership marker: {marker}") from exc
    if not isinstance(value, dict) or value.get("schema_version") != 1 or value.get("generator") != "scripts/benchmark_round4.py" or value.get("seed") != SEED:
        raise RuntimeError(f"fixture ownership marker is not owned by this generator: {marker}")
    files = value.get("files")
    if not isinstance(files, list) or not all(isinstance(item, dict) for item in files):
        raise RuntimeError(f"fixture ownership marker has invalid files: {marker}")
    expected_names = {item["path"].name for item in specs}
    if any(not isinstance(item.get("name"), str) for item in files):
        raise RuntimeError("fixture ownership marker has a non-string file name")
    marker_names = {item["name"] for item in files}
    if len(files) != len(expected_names) or marker_names != expected_names or any(not isinstance(item.get("sha256"), str) or len(item["sha256"]) != 64 or any(character not in "0123456789abcdef" for character in item["sha256"].lower()) for item in files):
        raise RuntimeError("fixture ownership marker does not cover exactly the generator-owned files")
    return value


def _prepare_fixture_dir(root: Path, specs: list[dict[str, Any]], *, force: bool) -> bool:
    root.mkdir(parents=True, exist_ok=True)
    root_abs = Path(os.path.abspath(root))
    root_real = root_abs.resolve()

    def safe_child(path: Path) -> Path:
        candidate = Path(os.path.abspath(path))
        if candidate.parent != root_abs:
            raise RuntimeError(f"fixture path escapes fixture directory: {path}")
        if candidate.is_symlink():
            raise RuntimeError(f"refuse symlink/reparse fixture path: {candidate}")
        if candidate.exists() and candidate.resolve().parent != root_real:
            raise RuntimeError(f"fixture path resolves outside fixture directory: {candidate}")
        return candidate

    expected_paths = {safe_child(item["path"]) for item in specs}
    marker = safe_child(root / MARKER_NAME)
    existing_files = {Path(os.path.abspath(item)) for item in root.iterdir() if item.is_file() or item.is_symlink()}
    if not marker.exists():
        if existing_files:
            raise RuntimeError(
                "fixture directory is not empty and has no valid ownership marker; refuse to label or overwrite existing files"
            )
        return False
    ownership = _validate_marker(marker, specs)
    unknown = existing_files.difference(expected_paths, {marker.resolve()})
    if unknown:
        raise RuntimeError(
            f"fixture directory contains unrelated files; refuse to overwrite: {sorted(map(str, unknown))}"
        )
    marker_hashes = {item["name"]: item["sha256"] for item in ownership["files"]}
    changed = [
        path
        for path in expected_paths
        if not path.is_file() or _sha256(path) != marker_hashes.get(path.name)
    ]
    if changed and not force:
        raise RuntimeError(
            f"owned fixture content changed; pass --force only to regenerate these owned files: {sorted(map(str, changed))}"
        )
    if not force and not changed:
        return True
    if force:
        for path in expected_paths:
            if path.exists():
                path.unlink()
        if marker.exists():
            marker.unlink()
    return False


def _probe_video(ffprobe: str, path: Path) -> dict[str, Any]:
    completed = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
        "stream=width,height,r_frame_rate,nb_frames,nb_read_frames,duration:format=duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if completed.returncode:
        raise RuntimeError(f"ffprobe failed for {path}: {completed.stderr.strip()}")
    try:
        payload = json.loads(completed.stdout)
        stream = payload["streams"][0]
        duration = float(stream.get("duration") or payload.get("format", {}).get("duration"))
        frame_count = int(stream.get("nb_read_frames") or stream.get("nb_frames") or 0)
        fps = float(Fraction(stream["r_frame_rate"]))
        result = {"width": int(stream["width"]), "height": int(stream["height"]), "fps": fps, "duration_seconds": duration, "frame_count": frame_count}
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        raise RuntimeError(f"ffprobe returned incomplete metadata for {path}") from exc
    if result["width"] != 320 or result["height"] != 180 or result["fps"] <= 0 or result["duration_seconds"] <= 0 or result["frame_count"] <= 0:
        raise RuntimeError(f"fixture metadata is invalid for {path}: {result}")
    if result["duration_seconds"] > 12.25:
        raise RuntimeError(f"fixture exceeds 12-second limit: {path}")
    return result


def _manifest_for_specs(specs: list[dict[str, Any]], manifest_path: Path, probes: dict[str, dict[str, Any]]) -> dict[str, Any]:
    videos = []
    by_id = {item["id"]: item for item in specs}
    for item in specs:
        path = item["path"].resolve()
        videos.append(
            {
                "id": item["id"],
                "path": path.relative_to(manifest_path.parent.resolve()).as_posix(),
                "duration_seconds": round(float(probes[item["id"]]["duration_seconds"]), 6),
                "sha256": _sha256(path),
                "width": probes[item["id"]]["width"],
                "height": probes[item["id"]]["height"],
                "fps": round(float(probes[item["id"]]["fps"]), 6),
                "frame_count": probes[item["id"]]["frame_count"],
            }
        )
    cases = []

    def positive(case_id: str, video_b: str, group: str, segment: dict[str, float], transform: str) -> None:
        cases.append(
            {
                "id": case_id,
                "video_a": "base",
                "video_b": video_b,
                "groups": [group],
                "expected_related": True,
                "expected_relation": "B_is_likely_clip_of_A",
                "segments": [segment],
                "transform": {"kind": transform, "source": by_id[video_b]["source"]},
            }
        )

    positive("base-exact", "exact", "exact", {"a_start": 3.0, "a_end": 6.0, "b_start": 0.0, "b_end": 3.0}, "trim")
    positive("base-short", "short", "short", {"a_start": 4.0, "a_end": 5.5, "b_start": 0.0, "b_end": 1.5}, "trim")
    positive("base-mirror", "mirror", "mirror", {"a_start": 3.0, "a_end": 6.0, "b_start": 0.0, "b_end": 3.0}, "trim+mirror")
    positive("base-crop", "crop", "crop", {"a_start": 3.0, "a_end": 6.0, "b_start": 0.0, "b_end": 3.0}, "trim+crop")
    positive("base-speed-2x", "speed_2x", "2xspeed", {"a_start": 3.0, "a_end": 6.0, "b_start": 0.0, "b_end": 1.5}, "trim+speed")
    cases.extend(
        [
            {
                "id": "base-unrelated",
                "video_a": "base",
                "video_b": "unrelated",
                "groups": ["unrelated"],
                "expected_related": False,
                "expected_relation": "different",
                "segments": [],
                "transform": {"kind": "independent"},
            },
            {
                "id": "shared-static-template",
                "video_a": "static_template",
                "video_b": "static_variant",
                "groups": ["shared_static_template"],
                "expected_related": False,
                "expected_relation": "different",
                "segments": [],
                "transform": {"kind": "shared_static_template_negative"},
            },
        ]
    )
    return {
        "schema_version": 1,
        "content_type": "content_copy",
        "split": "development",
        "annotation_source": "generated",
        "annotation": {
            "generator": "scripts/benchmark_round4.py",
            "seed": SEED,
            "description": "interval labels derive from the explicit local fixture construction recipes",
        },
        "videos": videos,
        "cases": cases,
    }


def generate_fixtures(
    *, fixture_dir: Path = DEFAULT_FIXTURE_DIR, manifest_path: Path = DEFAULT_MANIFEST,
    ffmpeg: str | None = None, force: bool = False,
) -> Path:
    fixture_dir = fixture_dir.expanduser().resolve()
    manifest_path = manifest_path.expanduser().resolve()
    base = fixture_dir / "base.mp4"
    specs = _fixture_specs(base, fixture_dir)
    reused = _prepare_fixture_dir(fixture_dir, specs, force=force)
    if not reused:
        encoder = _find_ffmpeg(ffmpeg)
        for item in specs:
            _run_ffmpeg(
                encoder,
                _encode_args(item["input"], item["path"], filters=item["filters"], output_duration=item.get("output_duration")),
                item["id"],
            )
    probe_tool = _find_ffprobe(ffmpeg or shutil.which("ffmpeg"))
    probes = {item["id"]: _probe_video(probe_tool, item["path"]) for item in specs}
    for item in specs:
        probe = probes[item["id"]]
        if abs(float(probe["duration_seconds"]) - float(item["duration_seconds"])) > 0.2:
            raise RuntimeError(
                f"fixture duration does not match construction recipe for {item['id']}: "
                f"expected {item['duration_seconds']}, observed {probe['duration_seconds']}"
            )
        if abs(float(probe["fps"]) - 12.0) > 0.01:
            raise RuntimeError(f"fixture fps is not 12 for {item['id']}: {probe['fps']}")
    marker = fixture_dir / MARKER_NAME
    _write_json(
        marker,
        {
            "schema_version": 1,
            "generator": "scripts/benchmark_round4.py",
            "seed": SEED,
            "files": [
                {"name": item["path"].name, "sha256": _sha256(item["path"])}
                for item in specs
            ],
        },
    )
    manifest = _manifest_for_specs(specs, manifest_path, probes)
    _write_json(manifest_path, manifest)
    return manifest_path


def _rss_snapshot() -> dict[str, Any]:
    try:
        from video_sim.metrics import process_memory_snapshot

        snapshot = process_memory_snapshot()
        current = snapshot.get("current_rss_bytes")
        peak = snapshot.get("peak_rss_bytes")
        return {
            "supported": current is not None or peak is not None,
            "current_rss_bytes": int(current) if current is not None else None,
            "peak_rss_bytes": int(peak) if peak is not None else None,
            "kind": "current_and_process_peak_sample",
        }
    except Exception as exc:  # pragma: no cover - optional dependency/platform
        return {"supported": False, "current_rss_bytes": None, "peak_rss_bytes": None, "kind": "unavailable", "error": str(exc)}


def evaluate_file(manifest_path: Path, report_path: Path, output_path: Path, *, iou_threshold: float, allow_extra_pairs: bool, report_media_root: Path | None = None) -> Path:
    from video_sim.evaluation import evaluate_report, load_manifest

    # This explicit verification is a benchmark-entry invariant.  The
    # evaluator is called with the path afterwards so relative media paths
    # retain manifest-directory semantics.
    load_manifest(manifest_path, verify_files=True)
    before_rss = _rss_snapshot()
    start_wall = time.perf_counter()
    start_cpu = time.process_time()
    result = evaluate_report(
        report_path,
        manifest_path,
        iou_threshold=iou_threshold,
        allow_extra_pairs=allow_extra_pairs,
        report_media_root=report_media_root,
    )
    elapsed_wall = (time.perf_counter() - start_wall) * 1000.0
    elapsed_cpu = (time.process_time() - start_cpu) * 1000.0
    after_rss = _rss_snapshot()
    payload = {
        "schema_version": "recognition-round4-benchmark-v1",
        "mode": "evaluate",
        "source": _git_source(),
        "environment": {"python": sys.version, "platform": platform.platform()},
        "parameters": {"manifest": str(manifest_path), "report": str(report_path), "verify_files": True, "report_media_root": str(report_media_root) if report_media_root else None, "iou_threshold": iou_threshold, "allow_extra_pairs": allow_extra_pairs},
        "timing": {"wall_ms": elapsed_wall, "cpu_ms": elapsed_cpu},
        "rss": {"before": before_rss, "after": after_rss, "note": "process current samples; not exact incremental allocation"},
        "evaluation": result,
        "limitations": [
            "Exploratory labelled evaluation; generated development fixtures are not human holdout evidence.",
            "Timing and RSS are same-process observations and must not be extrapolated to full E2E performance.",
        ],
    }
    _write_json(output_path, payload)
    return output_path


def _report_rows(value: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    pairs = value.get("video_pairs")
    if isinstance(pairs, list):
        if not all(isinstance(item, dict) for item in pairs):
            raise ValueError("report video_pairs must contain objects")
        return pairs, True
    return [value], False


def refine_file(report_path: Path, output_path: Path, *, mode: str, report_media_root: Path | None = None) -> Path:
    # Deliberately lazy: evaluation and fixture generation do not require the
    # in-development refinement core or a video decoder.
    report_path = report_path.expanduser().resolve()
    output_path = output_path.expanduser().resolve()
    if report_path == output_path:
        raise ValueError("refined output path must differ from input report path")
    original = json.loads(report_path.read_text(encoding="utf-8"))
    if not isinstance(original, dict):
        raise ValueError("refinement input report must be an object")
    if mode == "off":
        # Off is a no-op mode: preserve the report byte-for-byte at the JSON
        # value level and do not invent an empty refinement record.
        _write_json(output_path, original)
        return output_path
    from video_sim.segment_refiner import RefinementConfig, refine_segments

    refined = deepcopy(original)
    rows, is_batch = _report_rows(refined)
    config = RefinementConfig(mode=mode)
    preprocess_default = refined.get("preprocess_config")
    preprocess_sources: list[dict[str, Any]] = []
    before_rss = _rss_snapshot()
    start_wall = time.perf_counter()
    start_cpu = time.process_time()
    for index, row in enumerate(rows):
        left = row.get("video_a_path", row.get("video_a"))
        right = row.get("video_b_path", row.get("video_b"))
        if not isinstance(left, str) or not isinstance(right, str):
            raise ValueError(f"report row {index} lacks complete video paths")
        left_path = Path(left).expanduser()
        right_path = Path(right).expanduser()
        if not left_path.is_absolute() or not right_path.is_absolute():
            if report_media_root is None:
                raise ValueError(f"report row {index} requires complete absolute video paths or explicit report_media_root")
            root = report_media_root.resolve()
            left_path = (root / left_path).resolve(strict=False)
            right_path = (root / right_path).resolve(strict=False)
            for name, resolved in (("video_a", left_path), ("video_b", right_path)):
                try:
                    resolved.relative_to(root)
                except ValueError as exc:
                    raise ValueError(f"report row {index} {name} escapes report_media_root") from exc
        if not left_path.is_file() or not right_path.is_file():
            raise ValueError(f"report row {index} media path does not exist")
        segments = row.get("segments", [])
        if not isinstance(segments, list):
            raise ValueError(f"report row {index}.segments must be an array")
        if "preprocess_config" in row:
            preprocess = row["preprocess_config"]
            source = "row"
        elif preprocess_default is not None:
            preprocess = preprocess_default
            source = "report"
        else:
            preprocess = None
            source = "core_default_missing_input"
        preprocess_sources.append({"row": index, "source": source})
        result = refine_segments(
            str(left_path.resolve()),
            str(right_path.resolve()),
            deepcopy(segments),
            config=config,
            preprocess_config=preprocess,
            cancel_check=None,
        )
        row["segment_refinement"] = result or {
            "version": 1,
            "mode": mode,
            "config": config,
            "segments": [],
            "metrics": {},
        }
    elapsed_wall = (time.perf_counter() - start_wall) * 1000.0
    elapsed_cpu = (time.process_time() - start_cpu) * 1000.0
    after_rss = _rss_snapshot()
    source_values = {item["source"] for item in preprocess_sources}
    if source_values == {"report"}:
        preprocess_source = "input_report"
    elif source_values == {"core_default_missing_input"}:
        preprocess_source = "core_default_missing_input"
    else:
        preprocess_source = "per_row_or_report"
    refined["round4_refinement"] = {
        "mode": mode,
        "source_report": str(report_path),
        "source": _git_source(),
        "environment": {"python": sys.version, "platform": platform.platform()},
        "config": config,
        "preprocess_config_source": preprocess_source,
        "preprocess_config_sources": preprocess_sources,
        "timing": {"wall_ms": elapsed_wall, "cpu_ms": elapsed_cpu},
        "rss": {"before": before_rss, "after": after_rss, "note": "process current samples; not exact incremental allocation"},
        "input_shape": "batch" if is_batch else "single",
    }
    _write_json(output_path, refined)
    return output_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate-fixtures", action="store_true")
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURE_DIR)
    parser.add_argument("--manifest", type=Path, default=None)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--report-media-root", type=Path, help="explicit original cwd for relative report media paths")
    parser.add_argument("--output", type=Path, default=DEFAULT_EVALUATION)
    parser.add_argument("--ffmpeg")
    parser.add_argument("--force", action="store_true", help="replace only files owned by this fixture marker")
    parser.add_argument("--verify-files", action="store_true", help="retained for explicit CLI readability; evaluation always verifies")
    parser.add_argument("--allow-extra-pairs", action="store_true")
    parser.add_argument("--iou-threshold", type=float, default=0.5)
    parser.add_argument("--refine-report", type=Path)
    parser.add_argument("--refined-output", type=Path, default=DEFAULT_REFINED)
    parser.add_argument("--refinement-mode", choices=("off", "copy", "copy-mirror"), default="copy")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.refine_report:
        path = refine_file(args.refine_report.expanduser().resolve(), args.refined_output.expanduser().resolve(), mode=args.refinement_mode, report_media_root=args.report_media_root.expanduser().resolve() if args.report_media_root else None)
        print(json.dumps({"refined_report": str(path)}, ensure_ascii=False))
        return 0
    manifest_path = args.manifest.expanduser().resolve() if args.manifest else None
    if args.generate_fixtures:
        manifest_path = generate_fixtures(
            fixture_dir=args.fixtures,
            manifest_path=manifest_path or DEFAULT_MANIFEST,
            ffmpeg=args.ffmpeg,
            force=args.force,
        )
        print(json.dumps({"manifest": str(manifest_path)}, ensure_ascii=False))
    if args.report:
        if manifest_path is None:
            raise SystemExit("--report requires --manifest or --generate-fixtures")
        path = evaluate_file(
            manifest_path,
            args.report.expanduser().resolve(),
            args.output.expanduser().resolve(),
            iou_threshold=args.iou_threshold,
            allow_extra_pairs=args.allow_extra_pairs,
            report_media_root=args.report_media_root.expanduser().resolve() if args.report_media_root else None,
        )
        print(json.dumps({"evaluation": str(path)}, ensure_ascii=False))
    elif not args.generate_fixtures:
        raise SystemExit("choose --generate-fixtures, --report, or --refine-report")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
