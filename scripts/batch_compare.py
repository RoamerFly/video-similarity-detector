#!/usr/bin/env python3
"""
Batch compare script - Pairwise video similarity comparison with segment analysis.

Scans a directory for videos, performs pairwise bidirectional comparison,
and generates comprehensive reports with segment aggregation.

Usage:
    python scripts/batch_compare.py --input videos --cache-dir data --output data/reports/report.json
    python scripts/batch_compare.py --input videos --match-threshold 0.65 --window-size 30
    python scripts/batch_compare.py --input videos --crop-black-borders --resize-mode letterbox

Execution flow:
    1. Scan input directory for video files
    2. For each video, generate or reuse frame_features.npz cache
    3. Perform pairwise bidirectional comparison for all video pairs
    4. For each pair, compute window similarity and aggregate segments
    5. Output report.json, report.csv, report.html
"""

from __future__ import annotations

import argparse
from contextlib import nullcontext
import gc
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime
from pathlib import Path
from threading import Lock, RLock

import numpy as np

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def log(message: str) -> None:
    print(message, flush=True)


def emit_video_context(video_path: Path, phase: str) -> None:
    """Tell the desktop stderr reader which video native decoder logs belong to."""
    payload = json.dumps(
        {
            "path": display_path(video_path),
            "phase": str(phase),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    print(f"ANALYSIS_VIDEO_CONTEXT|{payload}", file=sys.stderr, flush=True)


def emit_video_quarantined(
    original_path: Path,
    destination_path: Path,
    remaining_videos: int,
    removed_videos: int,
    moved: bool = True,
) -> None:
    payload = json.dumps(
        {
            "originalPath": display_path(original_path),
            "destinationPath": display_path(destination_path),
            "remainingVideos": max(0, int(remaining_videos)),
            "removedVideos": max(1, int(removed_videos)),
            "moved": bool(moved),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    log(f"ANALYSIS_VIDEO_QUARANTINED|{payload}")


def display_path(path: Path) -> str:
    try:
        return str(path.resolve())
    except OSError:
        return str(path)


def _normalize_manifest_path(path: str | Path) -> str:
    return str(path).replace("\\", "/")


def _portable_path(path: Path, base: Path = PROJECT_ROOT) -> str:
    """将路径转为可移植格式：在项目根目录下则转相对路径，方便迁移。"""
    root = base.resolve()
    try:
        resolved = path.resolve(strict=False)
        return _normalize_manifest_path(resolved.relative_to(root))
    except (ValueError, OSError):
        try:
            return _normalize_manifest_path(path.resolve(strict=False))
        except OSError:
            return _normalize_manifest_path(path)


def progress_text(value: str) -> str:
    return str(value).replace("|", "／")


def compact_error(value: str) -> str:
    text = " ".join(str(value).replace("|", "／").split())
    if not text:
        return "未知错误"
    return text[:160] + ("..." if len(text) > 160 else "")


def resolve_ffmpeg(project_root: Path) -> str:
    executable_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    candidates = [
        os.environ.get("VIDEO_SIM_FFMPEG", "").strip(),
        str(project_root / "env" / executable_name),
        str(project_root / "tools" / executable_name),
        str(project_root / "desktop" / "env_gpu" / executable_name),
        str(project_root / "desktop" / "env" / executable_name),
        str(Path(sys.executable).resolve().parent.parent.parent / "env" / executable_name),
        shutil.which("ffmpeg") or "",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise FileNotFoundError("FFmpeg executable was not found for video validation")


ERROR_TOLERANCE_POLICIES = {
    "strict": {"severe_errors": 5, "missing_pictures": 20},
    "balanced": {"severe_errors": 20, "missing_pictures": 100},
    "lenient": {"severe_errors": 200, "missing_pictures": 1000},
    "failure_only": {"severe_errors": None, "missing_pictures": None},
}


def validate_video_stream(
    ffmpeg: str,
    video_path: Path,
    error_tolerance: str = "balanced",
    severe_error_limit: int | None = None,
    missing_picture_limit: int | None = None,
) -> str | None:
    policy = ERROR_TOLERANCE_POLICIES.get(
        error_tolerance,
        ERROR_TOLERANCE_POLICIES["balanced"],
    )
    severe_limit = policy["severe_errors"] if severe_error_limit is None else (
        max(1, severe_error_limit) if severe_error_limit > 0 else None
    )
    missing_limit = policy["missing_pictures"] if missing_picture_limit is None else (
        max(1, missing_picture_limit) if missing_picture_limit > 0 else None
    )
    command = [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-err_detect",
        "explode",
        "-i",
        str(video_path),
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        "copy",
        "-f",
        "null",
        os.devnull,
    ]
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    first_severe_error = ""
    fatal_error = ""
    severe_errors = 0
    missing_pictures = 0
    fatal_patterns = (
        "Error opening input",
        "Invalid data found when processing input",
        "moov atom not found",
        "does not contain any stream",
        "matches no streams",
    )
    severe_patterns = (
        "Invalid NAL unit size",
        "Error splitting the input into NAL units",
    )
    try:
        if process.stderr is not None:
            for raw_line in process.stderr:
                line = raw_line.strip()
                if not line:
                    continue
                if any(pattern in line for pattern in fatal_patterns):
                    fatal_error = line
                    first_severe_error = line
                    severe_errors = max(severe_errors, severe_limit or 1)
                    try:
                        process.terminate()
                    except OSError:
                        pass
                    break
                elif any(pattern in line for pattern in severe_patterns):
                    severe_errors += 1
                    if not first_severe_error:
                        first_severe_error = line
                elif "missing picture in access unit" in line:
                    missing_pictures += 1

                if (
                    (severe_limit is not None and severe_errors >= severe_limit)
                    or (missing_limit is not None and missing_pictures >= missing_limit)
                ):
                    try:
                        process.terminate()
                    except OSError:
                        pass
                    break
        try:
            return_code = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            return_code = process.wait(timeout=5)
    finally:
        if process.stderr is not None:
            process.stderr.close()

    if fatal_error:
        return compact_error(fatal_error)
    if severe_limit is not None and severe_errors >= severe_limit:
        return (
            f"{compact_error(first_severe_error)}；"
            f"连续检测到 {severe_errors} 条严重码流错误"
        )
    if missing_limit is not None and missing_pictures >= missing_limit:
        return f"连续检测到 {missing_pictures} 条缺失画面错误"
    if return_code != 0:
        if severe_limit is None and missing_limit is None and (severe_errors or missing_pictures):
            return None
        return f"FFmpeg 视频流校验失败，退出码 {return_code}"
    return None


def unique_quarantine_path(directory: Path, file_name: str) -> Path:
    candidate = directory / file_name
    if not candidate.exists():
        return candidate
    stem = Path(file_name).stem
    suffix = Path(file_name).suffix
    for index in range(1, 10_000):
        candidate = directory / f"{stem}_{index}{suffix}"
        if not candidate.exists():
            return candidate
    raise OSError(f"无法为错误视频生成唯一文件名: {file_name}")


def quarantine_video(video_path: Path, error_dir: Path) -> Path:
    error_dir.mkdir(parents=True, exist_ok=True)
    destination = unique_quarantine_path(error_dir, video_path.name)
    return Path(shutil.move(str(video_path), str(destination))).resolve()


def record_quarantine(
    error_dir: Path,
    original_path: Path,
    destination_path: Path,
    reason: str,
) -> None:
    manifest = error_dir / "quarantine_manifest.jsonl"
    entry = {
        "timestamp": datetime.now().isoformat(),
        "original_path": display_path(original_path),
        "destination_path": display_path(destination_path),
        "reason": compact_error(reason),
    }
    with manifest.open("a", encoding="utf-8") as file:
        file.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")


def is_video_decode_failure(error: Exception) -> bool:
    text = str(error).lower()
    return any(
        marker in text
        for marker in (
            "cannot open video",
            "decoded no usable frames",
            "no frames retained",
            "error splitting the input",
            "invalid nal unit",
            "failed to decode",
            "unable to decode",
            "decord",
        )
    )


TASK_STAGE_DEFINITIONS = (
    ("scan", "扫描与码流校验", 12.0),
    ("cache", "检查可复用缓存", 8.0),
    ("features", "动态抽帧与特征提取", 35.0),
    ("candidate", "候选视频粗筛", 8.0),
    ("compare", "视频两两比较", 30.0),
    ("report", "生成分析报告", 7.0),
)
TASK_STAGE_IDS = tuple(stage_id for stage_id, _, _ in TASK_STAGE_DEFINITIONS)
PHASE_TO_TASK_STAGE = {
    "scan": "scan",
    "model": "cache",
    "index": "features",
    "candidate": "candidate",
    "compare": "compare",
    "report": "report",
}


def default_task_stages() -> list[dict]:
    return [
        {
            "id": stage_id,
            "label": label,
            "status": "pending",
            "progress": 0.0,
            "weight": weight,
            "startedAt": "",
            "completedAt": "",
            "elapsedMs": 0,
            "message": "等待前置阶段完成",
        }
        for stage_id, label, weight in TASK_STAGE_DEFINITIONS
    ]


def merge_task_stages(existing_stages) -> list[dict]:
    existing = {
        str(stage.get("id")): stage
        for stage in (existing_stages or [])
        if isinstance(stage, dict) and stage.get("id")
    }
    stages = default_task_stages()
    for stage in stages:
        stage.update(existing.get(stage["id"], {}))
    return stages


def task_stage_index(stage_id: str) -> int:
    try:
        return TASK_STAGE_IDS.index(stage_id)
    except ValueError:
        return -1


def task_stage_progress(stages: list[dict]) -> float:
    total_weight = sum(max(0.0, float(stage.get("weight") or 0.0)) for stage in stages)
    if total_weight <= 0:
        return 0.0
    completed = sum(
        max(0.0, float(stage.get("weight") or 0.0))
        * min(100.0, max(0.0, float(stage.get("progress") or 0.0)))
        / 100.0
        for stage in stages
    )
    return round(completed / total_weight * 100.0, 2)


def parse_iso_time(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def update_task_stage(
    stage_id: str,
    status: str,
    progress: float,
    message: str,
) -> None:
    if globals().get("ACTIVE_TASK_MANIFEST_PATH") is None:
        return
    stages = merge_task_stages(ACTIVE_TASK_MANIFEST.get("stages"))
    stage = next((item for item in stages if item["id"] == stage_id), None)
    if stage is None:
        return

    now = datetime.now()
    previous_status = str(stage.get("status") or "pending")
    if status == "running" and previous_status != "running":
        stage["startedAt"] = now.isoformat()
        stage["completedAt"] = ""
    if status in {"paused", "completed", "failed"} and previous_status == "running":
        started_at = parse_iso_time(stage.get("startedAt", ""))
        if started_at is not None:
            stage["elapsedMs"] = max(0, int(stage.get("elapsedMs") or 0)) + max(
                0,
                int((now - started_at).total_seconds() * 1000),
            )
        stage["startedAt"] = ""
    if status == "completed":
        stage["completedAt"] = now.isoformat()
        progress = 100.0

    stage["status"] = status
    stage["progress"] = round(min(100.0, max(0.0, float(progress))), 2)
    stage["message"] = message
    active_stage = stage_id if status in {"running", "paused"} else ""
    update_task_manifest(
        status="running" if status == "running" else ACTIVE_TASK_MANIFEST.get("status", "running"),
        stages=stages,
        activeStage=active_stage,
        progress=task_stage_progress(stages),
        stage=message,
    )


def reset_task_stage_and_downstream(stage_id: str) -> None:
    stages = merge_task_stages(ACTIVE_TASK_MANIFEST.get("stages"))
    index = task_stage_index(stage_id)
    if index < 0:
        return
    for stage in stages[index:]:
        stage.update({
            "status": "pending",
            "progress": 0.0,
            "startedAt": "",
            "completedAt": "",
            "elapsedMs": 0,
            "message": "等待前置阶段完成",
        })
    update_task_manifest(
        stages=stages,
        activeStage="",
        progress=task_stage_progress(stages),
        completedPairs=0 if stage_id in {"scan", "cache", "features", "candidate", "compare"} else ACTIVE_TASK_MANIFEST.get("completedPairs", 0),
    )


def validate_stage_prerequisites(stage_id: str) -> None:
    index = task_stage_index(stage_id)
    if index < 0:
        raise ValueError(f"Unknown task stage: {stage_id}")
    stages = merge_task_stages(ACTIVE_TASK_MANIFEST.get("stages"))
    incomplete = [
        stage["label"]
        for stage in stages[:index]
        if stage.get("status") != "completed"
    ]
    if incomplete:
        raise RuntimeError(f"请先完成前置阶段：{'、'.join(incomplete)}")


def task_stage_is_completed(stage_id: str) -> bool:
    stages = merge_task_stages(ACTIVE_TASK_MANIFEST.get("stages"))
    return any(
        stage.get("id") == stage_id and stage.get("status") == "completed"
        for stage in stages
    )


def finish_stage_only(stage_id: str) -> bool:
    target_stage = str(globals().get("TARGET_TASK_STAGE") or "")
    if target_stage != stage_id:
        return False
    stages = merge_task_stages(ACTIVE_TASK_MANIFEST.get("stages"))
    label = next((stage["label"] for stage in stages if stage["id"] == stage_id), stage_id)
    update_task_manifest(
        status="staged",
        activeStage="",
        progress=task_stage_progress(stages),
        stage=f"{label}完成，可继续下一阶段",
    )
    return True


def record_task_cache_artifact(path: Path, description: str) -> None:
    artifacts = [
        item
        for item in (ACTIVE_TASK_MANIFEST.get("cacheArtifacts") or [])
        if isinstance(item, dict) and item.get("path")
    ]
    normalized, path_base = _artifact_path_reference(path)
    compare_key = _artifact_compare_key({"path": normalized, "pathBase": path_base})
    if any(_artifact_compare_key(item) == compare_key for item in artifacts):
        return
    artifacts.append({
        "path": normalized,
        "pathBase": path_base,
        "category": "任务生成缓存",
        "description": description,
        "createdAt": datetime.now().isoformat(),
    })
    update_task_manifest(cacheArtifacts=artifacts, generatedVideoCaches=len(artifacts))


def emit_progress(
    phase: str,
    current: float,
    total: float,
    message: str,
    sub_current: float | None = None,
    sub_total: float | None = None,
    sub_label: str = "",
) -> None:
    parts = [
        "PROGRESS",
        phase,
        f"{float(current):.6f}",
        f"{float(max(total, 1)):.6f}",
        progress_text(message),
    ]
    if sub_current is not None and sub_total is not None:
        parts.extend([
            f"{float(sub_current):.6f}",
            f"{float(max(sub_total, 1)):.6f}",
            progress_text(sub_label),
        ])
    log("|".join(parts))
    if globals().get("ACTIVE_TASK_MANIFEST_PATH") is not None:
        with TASK_MANIFEST_LOCK:
            ratio = min(1.0, max(0.0, float(current) / max(float(total), 1.0)))
            stage_id = PHASE_TO_TASK_STAGE.get(phase)
            if stage_id and (not TARGET_TASK_STAGE or stage_id == TARGET_TASK_STAGE):
                update_task_stage(
                    stage_id,
                    "completed" if ratio >= 1.0 else "running",
                    ratio * 100.0,
                    message,
                )
            elif phase == "done":
                update_task_manifest(status="completed", progress=100.0, stage=message, activeStage="")


def emit_candidate_progress(
    current: float,
    total: float,
    message: str,
    sub_current: float | None = None,
    sub_total: float | None = None,
    sub_label: str = "",
) -> None:
    if os.environ.get("VIDEO_SIM_PROGRESS_PROTOCOL_VERSION") != "2":
        return
    emit_progress(
        "candidate",
        current,
        total,
        message,
        sub_current,
        sub_total,
        sub_label,
    )


def comparison_sub_progress(
    direction: str,
    done: int,
    total: int,
    total_frames_a: int,
    total_frames_b: int,
    first_direction: str | None = None,
) -> tuple[int, int, str]:
    total_frames_a = max(1, int(total_frames_a))
    total_frames_b = max(1, int(total_frames_b))
    pair_total_frames = max(1, total_frames_a + total_frames_b)
    total = max(1, int(total))
    done = min(max(0, int(done)), total)
    first_direction = first_direction or ("a_to_b" if total_frames_a <= total_frames_b else "b_to_a")
    if first_direction == "a_to_b":
        pair_done = done if direction == "a_to_b" else total_frames_a + done
    else:
        pair_done = done if direction == "b_to_a" else total_frames_b + done
    direction_label = "A→B" if direction == "a_to_b" else "B→A"
    return min(max(0, pair_done), pair_total_frames), pair_total_frames, direction_label


def probe_video_frame_count(video_path: Path, ffmpeg: str = "") -> int:
    ffprobe_name = "ffprobe.exe" if os.name == "nt" else "ffprobe"
    ffprobe = Path(ffmpeg).with_name(ffprobe_name) if ffmpeg else None
    if ffprobe and ffprobe.is_file():
        try:
            result = subprocess.run(
                [
                    str(ffprobe),
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=nb_frames,avg_frame_rate,duration",
                    "-of",
                    "json",
                    str(video_path),
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                check=False,
            )
            stream = (json.loads(result.stdout or "{}").get("streams") or [{}])[0]
            frame_count = int(stream.get("nb_frames") or 0)
            if frame_count > 0:
                return frame_count
            duration = float(stream.get("duration") or 0)
            numerator, denominator = str(stream.get("avg_frame_rate") or "0/1").split("/", 1)
            fps = float(numerator) / max(float(denominator), 1.0)
            if duration > 0 and fps > 0:
                return max(1, int(round(duration * fps)))
        except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError):
            pass

    try:
        import cv2

        capture = cv2.VideoCapture(str(video_path))
        if not capture.isOpened():
            return 1
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        capture.release()
        return max(1, frame_count)
    except Exception:
        return 1


class AnalysisCancelled(Exception):
    """Raised when the desktop app requests a graceful cancellation."""


def raise_if_cancelled(cancel_file: Path | None) -> None:
    if cancel_file and cancel_file.exists():
        raise AnalysisCancelled("Analysis cancelled by user.")


def file_fingerprint(path: Path) -> dict:
    try:
        stat = path.stat()
        return {
            "path": str(path.resolve()),
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        }
    except OSError:
        return {"path": str(path.resolve()), "size": None, "mtime_ns": None}


def build_resume_signature(videos: list[Path], args, preprocess_config, resolved_device: str) -> dict:
    return {
        "containment_scoring_version": 4,
        "skip_threshold": args.skip_threshold,
        "max_gap_sec": args.max_gap_sec,
        "frame_step": max(1, int(args.frame_step)),
        "match_threshold": args.match_threshold,
        "window_size": args.window_size,
        "top_k": args.top_k,
        "min_segment_duration": args.min_segment_duration,
        "min_segment_matches": args.min_segment_matches,
        "offset_tolerance": args.offset_tolerance,
        "force": bool(args.force),
        "error_tolerance": args.error_tolerance,
        "error_severe_limit": args.error_severe_limit,
        "error_missing_limit": args.error_missing_limit,
        "preflight_validation": not args.skip_stream_validation,
        "early_stop": not bool(args.disable_early_stop),
        "crop_black_borders": preprocess_config.crop_black_borders,
        "resize_mode": preprocess_config.resize_mode.value,
        "input_size": preprocess_config.input_size,
        "portrait_rotation": preprocess_config.portrait_rotation.value,
        "device": resolved_device,
    }


def pair_key(video_a: Path, video_b: Path) -> str:
    identities = []
    for path in (video_a, video_b):
        fingerprint = file_fingerprint(path)
        identities.append(
            f"{fingerprint.get('path', '')}|{fingerprint.get('size')}|{fingerprint.get('mtime_ns')}"
        )
    left, right = sorted(identities)
    return f"{left}||{right}"


def cache_duration_seconds(cache) -> float:
    metadata = cache.metadata if isinstance(cache.metadata, dict) else {}
    for key in ("duration_sec", "source_duration_sec", "retained_duration_sec"):
        try:
            duration = float(metadata.get(key) or 0.0)
        except (TypeError, ValueError):
            continue
        if duration > 0:
            return duration
    if len(cache.timestamps) > 0:
        return max(0.0, float(cache.timestamps[-1]))
    return 0.0


def task_video_records(videos: list[Path]) -> list[dict]:
    records = []
    for video_path in videos:
        fingerprint = file_fingerprint(video_path)
        mtime_ns = fingerprint.get("mtime_ns")
        records.append({
            "path": fingerprint.get("path", ""),
            "size": fingerprint.get("size"),
            "mtimeMs": int(mtime_ns // 1_000_000) if isinstance(mtime_ns, int) else None,
        })
    return records


def resume_state_path(report_dir: Path, input_dir: Path, signature: dict) -> Path:
    signature_json = json.dumps(signature, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    signature_hash = hashlib.sha256(signature_json.encode("utf-8")).hexdigest()[:20]
    directory_name = "".join(
        character if character.isalnum() or character in {"-", "_"} else "_"
        for character in (input_dir.name or "videos")
    ).strip("_") or "videos"
    return report_dir / ".resume" / f"analysis_{directory_name}_{signature_hash}.state.json"


def load_resume_state(state_path: Path, signature: dict) -> dict:
    incremental_pairs = load_incremental_resume_pairs(state_path, signature)
    if incremental_pairs:
        return {"signature": signature, "pairs": incremental_pairs}

    candidates = [state_path]
    if state_path.parent.exists():
        candidates.extend(
            sorted(
                state_path.parent.glob(f"{state_path.name}.*.pending"),
                key=lambda path: path.stat().st_mtime if path.exists() else 0,
                reverse=True,
            )
        )
        candidates.extend(
            sorted(
                (
                    path
                    for path in state_path.parent.glob("*.state.json")
                    if path != state_path
                ),
                key=lambda path: path.stat().st_mtime if path.exists() else 0,
                reverse=True,
            )
        )

    valid_states = []
    for candidate in candidates:
        state = read_resume_state_file(candidate, signature)
        if state is not None:
            state["_source_path"] = str(candidate)
            valid_states.append(state)
            if candidate != state_path:
                break

    state = (
        max(valid_states, key=lambda item: len(item.get("pairs", {})))
        if valid_states
        else {"signature": signature, "pairs": {}}
    )
    source_path = state.pop("_source_path", "")
    if source_path and Path(source_path) != state_path and state["pairs"]:
        log(f"正在迁移 {len(state['pairs'])} 条旧断点续跑记录到增量 SQLite 检查点(Migrating legacy resume pairs to incremental SQLite checkpoint)...")
        try:
            save_resume_pairs(state_path, signature, state["pairs"])
        except OSError as migration_error:
            log(f"警告(Warning): 迁移断点续跑记录失败: {compact_error(migration_error)}")
    return state


def load_incremental_resume_pairs(state_path: Path, signature: dict) -> dict:
    pairs = load_resume_sqlite(state_path, signature)
    pairs.update(load_legacy_resume_pair_files(state_path, signature))
    return pairs


def load_resume_sqlite(state_path: Path, signature: dict) -> dict:
    database_path = resume_pair_database_path(state_path, signature)
    if not database_path.exists():
        return {}
    try:
        with sqlite3.connect(database_path, timeout=30) as connection:
            rows = connection.execute("SELECT pair_key, pair_json FROM completed_pairs").fetchall()
    except (sqlite3.Error, OSError):
        return {}

    pairs = {}
    for key, pair_json in rows:
        try:
            pair = json.loads(pair_json)
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(key, str) and isinstance(pair, dict):
            pairs[key] = pair
    return pairs


def load_legacy_resume_pair_files(state_path: Path, signature: dict) -> dict:
    pair_dir = resume_pair_store_dir(state_path, signature)
    if not pair_dir.exists():
        return {}

    pairs = {}
    pair_files = list(pair_dir.glob("*.json")) + list(pair_dir.glob("*.json.*.pending"))
    for pair_path in pair_files:
        try:
            with open(pair_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        key = payload.get("key")
        pair = payload.get("pair")
        if isinstance(key, str) and isinstance(pair, dict):
            pairs[key] = pair
    return pairs


def read_resume_state_file(state_path: Path, signature: dict) -> dict | None:
    if not state_path.exists():
        return None
    try:
        with open(state_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if data.get("signature") != signature:
        return None
    pairs = data.get("pairs")
    return {
        "signature": signature,
        "pairs": pairs if isinstance(pairs, dict) else {},
    }


def save_resume_pair(state_path: Path, signature: dict, key: str, pair: dict) -> None:
    save_resume_pairs(state_path, signature, {key: pair})


def save_resume_pairs(
    state_path: Path,
    signature: dict,
    pairs: dict[str, dict],
) -> None:
    database_path = resume_pair_database_path(state_path, signature)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        (key, json.dumps(pair, ensure_ascii=False, separators=(",", ":")))
        for key, pair in pairs.items()
    ]
    last_error: Exception | None = None
    for attempt in range(8):
        try:
            with sqlite3.connect(database_path, timeout=30) as connection:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("PRAGMA synchronous=NORMAL")
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS completed_pairs ("
                    "pair_key TEXT PRIMARY KEY, pair_json TEXT NOT NULL"
                    ")"
                )
                connection.executemany(
                    "INSERT INTO completed_pairs(pair_key, pair_json) VALUES(?, ?) "
                    "ON CONFLICT(pair_key) DO UPDATE SET pair_json=excluded.pair_json",
                    rows,
                )
                connection.commit()
            return
        except (sqlite3.Error, OSError) as exc:
            last_error = exc
            time.sleep(0.12 * (attempt + 1))
    raise OSError(f"SQLite resume checkpoint is unavailable: {last_error}")


ACTIVE_TASK_MANIFEST_PATH: Path | None = None
ACTIVE_TASK_CACHE_DIR: Path | None = None
ACTIVE_TASK_MANIFEST: dict = {}
TASK_MANIFEST_LOCK = RLock()
TARGET_TASK_STAGE = ""


def task_state_path(cache_dir: Path, task_id: str) -> Path:
    safe_task_id = "".join(
        character
        for character in str(task_id)
        if character.isascii() and (character.isalnum() or character in {"-", "_"})
    )
    if not safe_task_id:
        safe_task_id = f"analysis-{int(time.time() * 1000)}"
    return cache_dir / "cache" / "tasks" / safe_task_id / "resume.state.json"


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(f"{path.name}.{os.getpid()}.pending")
    with open(pending, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    import time
    for attempt in range(5):
        try:
            os.replace(pending, path)
            break
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.1)


def task_cache_dir_from_manifest_path(manifest_path: Path | None) -> Path | None:
    if manifest_path is None or len(manifest_path.parents) < 4:
        return None
    return manifest_path.parents[3]


def _artifact_path_reference(path: Path) -> tuple[str, str]:
    cache_dir = ACTIVE_TASK_CACHE_DIR or task_cache_dir_from_manifest_path(ACTIVE_TASK_MANIFEST_PATH)
    if cache_dir is not None:
        try:
            resolved = path.resolve(strict=False)
            cache_root = cache_dir.resolve(strict=False)
            return _normalize_manifest_path(resolved.relative_to(cache_root)), "cacheDir"
        except (ValueError, OSError):
            pass
    portable = _portable_path(path)
    if Path(portable).is_absolute():
        return portable, "absolute"
    return portable, "projectRoot"


def _artifact_compare_key(item: dict) -> str:
    raw_path = str(item.get("path") or "")
    raw = Path(raw_path)
    if raw.is_absolute():
        candidate = raw
    else:
        path_base = str(item.get("pathBase") or "")
        if path_base == "cacheDir":
            base = ACTIVE_TASK_CACHE_DIR or task_cache_dir_from_manifest_path(ACTIVE_TASK_MANIFEST_PATH)
            candidate = (base or PROJECT_ROOT) / raw
        elif path_base == "absolute":
            candidate = raw
        else:
            candidate = PROJECT_ROOT / raw
    try:
        return _normalize_manifest_path(candidate.resolve(strict=False)).casefold()
    except OSError:
        return _normalize_manifest_path(candidate).casefold()


def parse_task_config(raw_value: str) -> dict:
    if not raw_value:
        return {}
    try:
        payload = json.loads(raw_value)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def load_task_config(raw_value: str = "", config_path: str = "") -> dict:
    if not config_path:
        return parse_task_config(raw_value)
    payload = Path(config_path).read_text(encoding="utf-8-sig")
    return parse_task_config(payload)


def load_video_list(video_list_path: str, input_dir: Path, error_video_dir: Path) -> list[Path]:
    if not video_list_path:
        return []
    try:
        payload = json.loads(Path(video_list_path).read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        log(f"错误(Error): 读取指定视频列表失败: {exc}")
        sys.exit(1)
    if not isinstance(payload, list):
        log("错误(Error): 指定视频列表必须是 JSON 数组")
        sys.exit(1)

    videos: list[Path] = []
    seen: set[str] = set()
    for item in payload:
        if not isinstance(item, str) or not item.strip():
            continue
        candidate = Path(item.strip())
        if not candidate.is_absolute():
            candidate = input_dir / candidate
        try:
            resolved = candidate.resolve()
        except OSError:
            log(f"  Skipping unavailable selected video: {candidate}")
            continue
        if str(resolved) in seen:
            continue
        if error_video_dir in resolved.parents:
            continue
        if not resolved.is_file():
            log(f"  Skipping missing selected video: {resolved}")
            continue
        videos.append(resolved)
        seen.add(str(resolved))
    return sorted(videos, key=lambda path: path.name.lower())


def start_task_manifest(
    manifest_path: Path,
    task_id: str,
    input_dir: Path,
    videos: list[Path],
    total_pairs: int,
    completed_pairs: int,
    match_key: str,
    config: dict,
    output_base: Path,
) -> None:
    global ACTIVE_TASK_MANIFEST_PATH, ACTIVE_TASK_CACHE_DIR, ACTIVE_TASK_MANIFEST
    existing = {}
    if manifest_path.exists():
        try:
            with open(manifest_path, "r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                existing = loaded
        except (OSError, json.JSONDecodeError):
            existing = {}

    now = datetime.now().isoformat()
    video_records = task_video_records(videos)
    ACTIVE_TASK_MANIFEST_PATH = manifest_path
    ACTIVE_TASK_CACHE_DIR = task_cache_dir_from_manifest_path(manifest_path)
    ACTIVE_TASK_MANIFEST = {
        **existing,
        "version": 1,
        "id": task_id,
        "status": "running",
        "createdAt": existing.get("createdAt") or now,
        "updatedAt": now,
        "videoDir": display_path(input_dir),
        "videoCount": len(video_records),
        "totalPairs": max(0, int(total_pairs)),
        "completedPairs": max(0, int(completed_pairs)),
        "failedPairs": 0,
        "progress": task_stage_progress(merge_task_stages(existing.get("stages"))),
        "stage": "正在恢复历史进度" if completed_pairs else "准备比较视频对",
        "matchKey": match_key,
        "videos": video_records,
        "config": config,
        "reportJson": _portable_path(output_base.with_suffix(".json")),
        "reportCsv": _portable_path(output_base.with_suffix(".csv")),
        "reportHtml": _portable_path(output_base.with_suffix(".html")),
        "activeStage": existing.get("activeStage") or "",
        "stages": merge_task_stages(existing.get("stages")),
        "cacheArtifacts": existing.get("cacheArtifacts") or [],
        "reusedVideoCaches": int(existing.get("reusedVideoCaches") or 0),
        "generatedVideoCaches": int(existing.get("generatedVideoCaches") or 0),
    }
    write_json_atomic(manifest_path, ACTIVE_TASK_MANIFEST)


def activate_task_manifest(
    cache_dir: Path,
    task_id: str,
    input_dir: Path,
    videos: list[Path],
    match_key: str,
    config: dict,
) -> None:
    global ACTIVE_TASK_MANIFEST_PATH, ACTIVE_TASK_CACHE_DIR, ACTIVE_TASK_MANIFEST
    manifest_path = task_state_path(cache_dir, task_id).parent / "task.json"
    existing = {}
    if manifest_path.exists():
        try:
            with open(manifest_path, "r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                existing = loaded
        except (OSError, json.JSONDecodeError):
            existing = {}

    now = datetime.now().isoformat()
    fingerprints = task_video_records(videos)
    previous_fingerprints = {
        (item.get("path"), item.get("size"), item.get("mtimeMs"))
        for item in (existing.get("videos") or [])
        if isinstance(item, dict)
    }
    current_fingerprints = {
        (item.get("path"), item.get("size"), item.get("mtimeMs"))
        for item in fingerprints
    }
    directory_changed = bool(previous_fingerprints) and previous_fingerprints != current_fingerprints
    stages = merge_task_stages(existing.get("stages"))
    if directory_changed:
        for stage in stages:
            stage.update({
                "status": "pending",
                "progress": 0.0,
                "startedAt": "",
                "completedAt": "",
                "elapsedMs": 0,
                "message": "视频目录已变化，等待重新处理",
            })
    total_pairs = max(0, len(videos) * (len(videos) - 1) // 2)
    ACTIVE_TASK_MANIFEST_PATH = manifest_path
    ACTIVE_TASK_CACHE_DIR = cache_dir
    ACTIVE_TASK_MANIFEST = {
        **existing,
        "version": 1,
        "id": task_id,
        "status": "running",
        "createdAt": existing.get("createdAt") or now,
        "updatedAt": now,
        "videoDir": display_path(input_dir),
        "videoCount": len(videos),
        "totalPairs": total_pairs,
        "completedPairs": 0 if directory_changed else max(0, int(existing.get("completedPairs") or 0)),
        "failedPairs": 0,
        "progress": task_stage_progress(stages),
        "stage": "检测到增量视频，正在重新校验并复用未变化缓存" if directory_changed else "正在校验视频码流",
        "matchKey": match_key,
        "videos": fingerprints,
        "config": config or existing.get("config") or {},
        "reportJson": existing.get("reportJson") or "",
        "reportCsv": existing.get("reportCsv") or "",
        "reportHtml": existing.get("reportHtml") or "",
        "activeStage": existing.get("activeStage") or "",
        "stages": stages,
        "cacheArtifacts": existing.get("cacheArtifacts") or [],
        "reusedVideoCaches": int(existing.get("reusedVideoCaches") or 0),
        "generatedVideoCaches": int(existing.get("generatedVideoCaches") or 0),
    }
    write_json_atomic(manifest_path, ACTIVE_TASK_MANIFEST)


def update_task_manifest(**patch) -> None:
    with TASK_MANIFEST_LOCK:
        if ACTIVE_TASK_MANIFEST_PATH is None or not ACTIVE_TASK_MANIFEST:
            return
        ACTIVE_TASK_MANIFEST.update(patch)
        ACTIVE_TASK_MANIFEST["updatedAt"] = datetime.now().isoformat()
        try:
            write_json_atomic(ACTIVE_TASK_MANIFEST_PATH, ACTIVE_TASK_MANIFEST)
        except OSError as error:
            log(f"警告(Warning): 更新任务历史失败: {compact_error(error)}")


def resume_pair_database_path(state_path: Path, signature: dict) -> Path:
    signature_json = json.dumps(signature, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    signature_hash = hashlib.sha256(signature_json.encode("utf-8")).hexdigest()[:16]
    return state_path.with_name(f"{state_path.stem}.pairs-{signature_hash}.sqlite3")


def resume_pair_store_dir(state_path: Path, signature: dict) -> Path:
    signature_json = json.dumps(signature, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    signature_hash = hashlib.sha256(signature_json.encode("utf-8")).hexdigest()[:16]
    return state_path.with_name(f"{state_path.stem}.pairs-{signature_hash}")


def clear_resume_pairs(state_path: Path, signature: dict) -> None:
    database_path = resume_pair_database_path(state_path, signature)
    for path in (
        database_path,
        database_path.with_name(f"{database_path.name}-wal"),
        database_path.with_name(f"{database_path.name}-shm"),
    ):
        path.unlink(missing_ok=True)
    pair_dir = resume_pair_store_dir(state_path, signature)
    if pair_dir.exists():
        shutil.rmtree(pair_dir)


def add_preprocess_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--crop-black-borders",
        action="store_true",
        default=False,
        help="Auto-crop black borders from frames (default: disabled)",
    )
    parser.add_argument(
        "--resize-mode",
        type=str,
        default="center_crop",
        choices=["center_crop", "letterbox"],
        help="Resize mode for aspect ratio handling (default: center_crop)",
    )
    parser.add_argument(
        "--input-size",
        type=int,
        default=224,
        help="Matching resolution used before similarity calculation (default: 224)",
    )
    parser.add_argument(
        "--portrait-rotation",
        type=str,
        default="right_90",
        choices=["left_90", "right_90"],
        help="Rotate cropped portrait videos left or right before matching (default: right_90)",
    )


def ensure_video_indexed(
    video_path: Path,
    cache_dir: Path,
    skip_threshold: float,
    max_gap_sec: float,
    frame_step: int,
    device: str,
    embedder=None,
    force: bool = False,
    preprocess_config: PreprocessConfig = None,
    progress_callback=None,
    embed_progress_callback=None,
    metrics=None,
):
    """
    Ensure a video is indexed (has frame embeddings cache).

    If cache doesn't exist or force=True, perform dynamic frame sampling and embedding extraction.

    Args:
        video_path: Path to the video file
        cache_dir: Base cache directory
        skip_threshold: pHash similarity threshold for skipping frames
        max_gap_sec: Maximum seconds between retained frames
        device: Device for embedding
        embedder: VideoEmbedder instance
        force: Force recomputation even if cache exists
        preprocess_config: Configuration for frame preprocessing

    Returns:
        Tuple of (FrameEmbeddingCache, VideoEmbedder or None, cache_hit)
    """
    from video_sim.embedder import (
        FrameEmbeddingCache,
        VideoEmbedder,
        embed_frames_with_cache,
        embedding_runtime_fingerprint,
    )
    from video_sim.frame_sampler import DynamicFrameSampler

    cache_path = FrameEmbeddingCache.get_cache_path(
        video_path,
        cache_dir,
        preprocess_config,
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
    )

    if not force:
        cache = FrameEmbeddingCache.load_valid(
            video_path,
            cache_dir,
            preprocess_config,
            skip_threshold=skip_threshold,
            max_gap_sec=max_gap_sec,
            frame_step=frame_step,
            embedding_runtime=embedding_runtime_fingerprint(device),
        )
        if cache is not None:
            log(f"  缓存命中(Cache hit): {video_path.name}")
            log(f"  缓存文件(Cache file): {cache_path}")
            if metrics is not None:
                metrics.count("cache_hits")
                metrics.count("embeddings", len(cache.embeddings))
            return cache, embedder, True
        if cache_path.exists():
            log(f"  缓存已过期，重新构建(Cache stale, rebuilding): {cache_path}")
        else:
            legacy_path = FrameEmbeddingCache.get_legacy_cache_path(
                video_path,
                cache_dir,
                preprocess_config,
            )
            if legacy_path.exists():
                log(f"  旧缓存缺少校验元数据，将重新构建(Legacy cache lacks validation metadata, rebuilding): {legacy_path}")

    if force and cache_path.exists():
        log(f"  已启用强制重建，重新生成(Force enabled, regenerating): {video_path.name}")

    sampler = DynamicFrameSampler(
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
        cache_dir=cache_dir,
        preprocess_config=preprocess_config,
        metrics=metrics,
    )
    if embedder is None:
        log("正在初始化嵌入器(Initializing embedder)...")
        embedder = VideoEmbedder(device=device, preprocess_config=preprocess_config, metrics=metrics)
    elif metrics is not None:
        embedder.metrics = metrics

    log(f"  正在提取特征向量(Extracting embeddings): {video_path.name}")
    streaming_enabled = os.environ.get("VIDEO_SIM_STREAMING_PIPELINE", "1").strip().lower() not in {
        "0", "false", "no", "off"
    }
    if streaming_enabled:
        cache = embed_frames_with_cache(
            video_path=video_path,
            retained_frames=None,
            sampler=sampler,
            embedder=embedder,
            cache_dir=cache_dir,
            force=True,
            preprocess_config=preprocess_config,
            skip_threshold=skip_threshold,
            max_gap_sec=max_gap_sec,
            frame_step=frame_step,
            progress_callback=embed_progress_callback,
            sample_progress_callback=progress_callback,
            embedding_runtime=embedding_runtime_fingerprint(device),
        )
    else:
        sample_context = metrics.stage("decode_sample") if metrics is not None else nullcontext()
        with sample_context:
            retained_frames = sampler.sample(video_path, progress_callback=progress_callback)
        if not retained_frames:
            raise ValueError(f"No frames retained from {video_path}")
        cache = embed_frames_with_cache(
            video_path=video_path,
            retained_frames=retained_frames,
            embedder=embedder,
            cache_dir=cache_dir,
            force=True,
            preprocess_config=preprocess_config,
            skip_threshold=skip_threshold,
            max_gap_sec=max_gap_sec,
            frame_step=frame_step,
            source_duration_sec=sampler.source_duration_sec,
            progress_callback=embed_progress_callback,
            embedding_runtime=embedding_runtime_fingerprint(device),
        )
    if metrics is not None:
        metrics.count("embeddings", len(cache.embeddings))
    log(f"  已保存缓存(Saved cache): {cache_path}")

    return cache, embedder, False


def main():
    parser = argparse.ArgumentParser(
        description="Batch pairwise video similarity comparison with segment analysis"
    )
    parser.add_argument(
        "--input",
        type=str,
        required=True,
        help="Input directory containing video files",
    )
    parser.add_argument(
        "--cache-dir",
        type=str,
        default="data",
        help="Base cache directory (default: data)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output JSON report path (default: data/reports/batch_report_{timestamp}.json)",
    )
    parser.add_argument(
        "--skip-threshold",
        type=float,
        default=0.90,
        help="pHash similarity threshold for skipping frames (default: 0.90)",
    )
    parser.add_argument(
        "--max-gap-sec",
        type=float,
        default=5.0,
        help="Maximum seconds between retained frames (default: 5.0)",
    )
    parser.add_argument(
        "--frame-step",
        type=int,
        default=1,
        help="Analyze every Nth frame during dynamic sampling (default: 1)",
    )
    parser.add_argument(
        "--match-threshold",
        type=float,
        default=0.65,
        help="Minimum similarity threshold for a match (default: 0.65)",
    )
    parser.add_argument(
        "--window-size",
        type=float,
        default=30.0,
        help="Window size in seconds for time window similarity (default: 30)",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=10,
        help="Number of top results to retrieve per query (default: 10)",
    )
    parser.add_argument(
        "--candidate-limit",
        type=int,
        default=20,
        help="Maximum coarse-screened target videos per source; 0 compares every pair (default: 20)",
    )
    parser.add_argument(
        "--compare-workers",
        type=int,
        default=1,
        help="Number of video pairs to compare concurrently during the exact pass (default: 1)",
    )
    parser.add_argument(
        "--disable-early-stop",
        action="store_true",
        help="Disable conservative early-stop and force complete bidirectional comparison for every pair",
    )
    parser.add_argument(
        "--min-segment-duration",
        type=float,
        default=5.0,
        help="Minimum duration for a valid segment in seconds (default: 5)",
    )
    parser.add_argument(
        "--min-segment-matches",
        type=int,
        default=3,
        help="Minimum number of matches for a valid segment (default: 3)",
    )
    parser.add_argument(
        "--offset-tolerance",
        type=float,
        default=3.0,
        help="Maximum offset difference to consider matches as same segment (default: 3)",
    )
    parser.add_argument(
        "--device",
        type=str,
        default="auto",
        choices=["cpu", "cuda", "auto"],
        help="Device to use for embedding (default: auto)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-extraction of embeddings, ignoring existing cache",
    )
    parser.add_argument(
        "--error-tolerance",
        type=str,
        default="balanced",
        choices=["strict", "balanced", "lenient", "failure_only", "custom"],
        help="Video decode error tolerance preset (default: balanced)",
    )
    parser.add_argument(
        "--error-severe-limit",
        type=int,
        default=-1,
        help="Custom severe stream error threshold; 0 disables this threshold",
    )
    parser.add_argument(
        "--error-missing-limit",
        type=int,
        default=-1,
        help="Custom missing-picture threshold; 0 disables this threshold",
    )
    parser.add_argument(
        "--skip-stream-validation",
        action="store_true",
        help="Skip the full FFmpeg preflight stream validation pass",
    )
    parser.add_argument(
        "--cancel-file",
        type=str,
        default="",
        help="Path to a cancellation flag file created by the desktop app",
    )
    parser.add_argument(
        "--task-id",
        type=str,
        default="",
        help="Persistent desktop task id used for comparison resume history",
    )
    parser.add_argument(
        "--task-match-key",
        type=str,
        default="",
        help="Desktop-generated key for matching the same directory and analysis configuration",
    )
    parser.add_argument(
        "--task-config-json",
        type=str,
        default="",
        help="Legacy inline desktop run configuration stored with task history",
    )
    parser.add_argument(
        "--task-config-file",
        type=str,
        default="",
        help="JSON file containing the desktop run configuration stored with task history",
    )
    parser.add_argument(
        "--video-list",
        type=str,
        default="",
        help="JSON file with selected video paths to analyze instead of scanning the whole input directory",
    )
    parser.add_argument(
        "--target-stage",
        type=str,
        default="",
        choices=["", *TASK_STAGE_IDS],
        help="Run through one task stage and stop after it completes",
    )
    parser.add_argument(
        "--redo-stage",
        action="store_true",
        help="Reset the target stage and all downstream task stages before running",
    )
    # Add preprocessing arguments
    add_preprocess_args(parser)
    args = parser.parse_args()
    global TARGET_TASK_STAGE
    TARGET_TASK_STAGE = args.target_stage

    emit_progress("scan", 0, 1, "加载视频扫描模块")
    from video_sim.preprocess import PreprocessConfig
    from video_sim.scanner import scan_videos
    from video_sim.metrics import RecognitionMetrics

    # Create preprocess config
    preprocess_config = PreprocessConfig.from_args(args)
    metrics = RecognitionMetrics()
    cancel_file = Path(args.cancel_file) if args.cancel_file else None

    input_dir = Path(args.input)
    cache_dir = Path(args.cache_dir)
    raise_if_cancelled(cancel_file)
    try:
        task_config = load_task_config(args.task_config_json, args.task_config_file)
    except (OSError, json.JSONDecodeError) as exc:
        log(f"错误(Error): 读取任务配置失败: {exc}")
        sys.exit(1)

    if not input_dir.exists():
        log(f"错误(Error): 输入目录不存在: {input_dir}")
        sys.exit(1)

    # Scan and validate videos before Decord opens them. Native decoder errors
    # are captured here so a damaged file can be quarantined after the first
    # error instead of flooding the desktop stderr log.
    emit_progress("scan", 0, 1, "扫描视频目录")
    log(f"正在扫描视频目录(Scanning for videos in): {input_dir}")
    project_root = Path.cwd().resolve()
    error_video_dir = project_root / "data" / "error_videos"
    if args.video_list:
        scanned_videos = load_video_list(args.video_list, input_dir, error_video_dir)
        log(f"使用指定视频列表(Using selected video list): {args.video_list}")
    else:
        scanned_videos = [
            path
            for path in scan_videos(input_dir, recursive=True)
            if error_video_dir not in path.resolve().parents
        ]
    raise_if_cancelled(cancel_file)

    if len(scanned_videos) < 2:
        log(f"错误(Error): 至少需要 2 个视频才能比较，当前有 {len(scanned_videos)} 个")
        sys.exit(1)

    log(f"发现 {len(scanned_videos)} 个视频(Found {len(scanned_videos)} videos)")
    task_id = args.task_id or f"analysis-{int(time.time() * 1000)}"
    activate_task_manifest(
        cache_dir,
        task_id,
        input_dir,
        scanned_videos,
        args.task_match_key,
        task_config,
    )
    if args.target_stage:
        validate_stage_prerequisites(args.target_stage)
        if args.redo_stage:
            reset_task_stage_and_downstream(args.target_stage)
    reuse_completed_scan = (
        task_stage_is_completed("scan")
        and args.target_stage != "scan"
    )
    ffmpeg = ""
    videos = []
    video_frame_counts = {}
    removed_videos = 0
    original_video_count = len(scanned_videos)
    videos_to_validate = scanned_videos
    if reuse_completed_scan:
        videos = list(scanned_videos)
        videos_to_validate = []
        emit_progress(
            "scan",
            original_video_count,
            original_video_count,
            "复用已完成的扫描与码流校验，跳过重复校验",
            original_video_count,
            original_video_count,
            "跳过 FFmpeg 码流校验",
        )
        log("输入目录未变化，扫描预检已完成；跳过 FFmpeg 流校验(Scan preflight already completed for unchanged input; skipping FFmpeg stream validation).")
    else:
        ffmpeg = resolve_ffmpeg(project_root)

    for probe_index, video_path in enumerate(videos_to_validate, start=1):
        raise_if_cancelled(cancel_file)
        emit_progress(
            "scan",
            probe_index - 1,
            original_video_count,
            f"校验视频 {probe_index}/{original_video_count}：{video_path.name}",
            probe_index - 1,
            original_video_count,
            "校验视频码流",
        )
        validation_error = None
        if not args.skip_stream_validation:
            validation_error = validate_video_stream(
                ffmpeg,
                video_path,
                args.error_tolerance,
                None if args.error_severe_limit < 0 else args.error_severe_limit,
                None if args.error_missing_limit < 0 else args.error_missing_limit,
            )
        if validation_error:
            original_path = video_path.resolve()
            emit_progress(
                "scan",
                probe_index - 1,
                original_video_count,
                f"正在隔离错误视频：{video_path.name}",
                probe_index - 1,
                original_video_count,
                "移动到 data/error_videos",
            )
            destination_path = None
            move_error = ""
            try:
                destination_path = quarantine_video(video_path, error_video_dir)
                record_quarantine(
                    error_video_dir,
                    original_path,
                    destination_path,
                    validation_error,
                )
            except OSError as error:
                move_error = compact_error(error)

            removed_videos += 1
            remaining_videos = original_video_count - removed_videos
            emit_video_quarantined(
                original_path,
                destination_path or error_video_dir,
                remaining_videos,
                removed_videos,
                moved=destination_path is not None,
            )
            if destination_path is not None:
                print(
                    f"错误视频：{original_path}；原因：{validation_error}；"
                    f"已移动到data/error_videos目录：{destination_path}；"
                    f"已移出比较列表，剩余 {remaining_videos} 个视频。",
                    file=sys.stderr,
                    flush=True,
                )
            else:
                print(
                    f"错误视频：{original_path}；原因：{validation_error}；"
                    f"移动到data/error_videos目录失败：{move_error}；"
                    f"已移出比较列表，剩余 {remaining_videos} 个视频。",
                    file=sys.stderr,
                    flush=True,
                )
            continue

        video_frame_counts[video_path] = probe_video_frame_count(video_path, ffmpeg)
        videos.append(video_path)

    if len(videos) < 2:
        log(
            "Error: Need at least 2 valid videos for comparison after quarantining "
            f"{removed_videos} damaged video(s), found {len(videos)}"
        )
        sys.exit(1)

    emit_progress(
        "scan",
        original_video_count,
        original_video_count,
        f"扫描完成：可比较 {len(videos)} 个视频，已隔离 {removed_videos} 个错误视频",
        original_video_count,
        original_video_count,
        "视频信息读取完成",
    )
    update_task_manifest(
        videos=task_video_records(videos),
        videoCount=len(videos),
        totalPairs=max(0, len(videos) * (len(videos) - 1) // 2),
    )
    if finish_stage_only("scan"):
        return

    # Resolve device
    emit_progress("model", 0, 1, "准备运行设备")
    if args.device == "auto":
        import torch
        resolved_device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        resolved_device = args.device
    log(f"设备(Device): {resolved_device}")
    raise_if_cancelled(cancel_file)

    # Print preprocessing settings if non-default
    log(
        "预处理(Preprocessing): "
        f"裁剪黑边(crop_black_borders)={preprocess_config.crop_black_borders}, "
        f"缩放模式(resize_mode)={preprocess_config.resize_mode.value}, "
        f"匹配分辨率(match_resolution)={preprocess_config.input_size}, "
        f"竖屏旋转(portrait_rotation)={preprocess_config.portrait_rotation.value}, "
        f"扫描步长(frame_step)={max(1, int(args.frame_step))}"
    )
    log(
        "错误容忍(error_tolerance)="
        f"{args.error_tolerance}, severe_limit={args.error_severe_limit}, "
        f"missing_limit={args.error_missing_limit}, "
        f"preflight_validation={not args.skip_stream_validation}"
    )

    # Audit exact-profile caches before extraction. Cache hits are reduced to
    # bounded candidate summaries; full embeddings are loaded later by the
    # ExactResourcePool only while an active exact pair is being compared.
    emit_progress("model", 0, max(1, len(videos)), "检查可复用视频特征缓存")
    from video_sim.embedder import FrameEmbeddingCache, embedding_runtime_fingerprint

    # Candidate summaries are bounded and can outlive the full cache objects.
    # Exact caches are loaded later by ExactResourcePool only for active pairs.
    candidate_summaries = {}
    cache_artifacts = {}
    cache_hits = 0
    cache_misses = []
    force_feature_redo = args.target_stage == "features" and args.redo_stage
    for cache_index, video_path in enumerate(videos, start=1):
        raise_if_cancelled(cancel_file)
        cache = None if args.force or force_feature_redo else FrameEmbeddingCache.load_valid(
            video_path,
            cache_dir,
            preprocess_config,
            skip_threshold=args.skip_threshold,
            max_gap_sec=args.max_gap_sec,
            frame_step=args.frame_step,
            embedding_runtime=embedding_runtime_fingerprint(resolved_device),
        )
        if cache is None:
            cache_misses.append(video_path)
        else:
            from video_sim.candidate_selector import build_candidate_summary
            candidate_summaries[video_path] = build_candidate_summary(
                cache,
                representatives_per_video=64,
                max_index_frames_per_video=1024,
            )
            cache_artifacts[video_path] = FrameEmbeddingCache.get_cache_path(
                video_path,
                cache_dir,
                preprocess_config,
                skip_threshold=args.skip_threshold,
                max_gap_sec=args.max_gap_sec,
                frame_step=args.frame_step,
            )
            del cache
            cache_hits += 1
        emit_progress(
            "model",
            cache_index,
            max(1, len(videos)),
            f"缓存检查 {cache_index}/{len(videos)}：{video_path.name}",
            cache_index,
            max(1, len(videos)),
            f"可复用 {cache_hits} 个，需处理 {len(cache_misses)} 个",
        )
    update_task_manifest(reusedVideoCaches=cache_hits)
    log(f"缓存审计(Cache audit): {cache_hits} 个可复用，{len(cache_misses)} 个需重新提取。")
    if finish_stage_only("cache"):
        return

    # Index all videos
    log("\n正在索引视频(Indexing videos)...")
    embedder = None
    cache_rebuilds = 0
    warnings = []
    index_video_units = {
        video_path: max(1, int(video_frame_counts.get(video_path, 1))) * 2.0
        for video_path in videos
    }
    index_units_total = max(1.0, sum(index_video_units.values()))
    index_units_done = 0.0
    index_quarantined = set()

    for index, video_path in enumerate(videos, start=1):
        raise_if_cancelled(cancel_file)
        video_units = index_video_units[video_path]
        video_total_frames = max(1, int(video_frame_counts.get(video_path, 1)))
        if video_path in candidate_summaries:
            index_units_done += video_units
            emit_progress(
                "index",
                index_units_done,
                index_units_total,
                f"复用特征缓存 {index}/{len(videos)}：{video_path.name}",
                1,
                1,
                f"当前视频：{video_path.name} · 已复用缓存",
            )
            continue
        sample_started = False
        sample_completed = False
        sample_log_emitted = False
        sample_total_frames = video_total_frames
        sample_elapsed_seconds = 0.0
        emit_progress(
            "index",
            index_units_done,
            index_units_total,
            f"索引视频 {index}/{len(videos)}：{video_path.name}",
            0,
            1,
            f"当前视频：{video_path.name}",
        )
        log(f"  正在索引视频(Indexing video) {index}/{len(videos)}: {display_path(video_path)}")
        emit_video_context(video_path, "index")

        def emit_sample_log(success: bool, reason: str = ""):
            nonlocal sample_log_emitted
            if sample_log_emitted:
                return
            sample_log_emitted = True
            if success:
                status = "[成功]"
            else:
                status = f"[失败: {compact_error(reason)}]"
            log(
                f"动态抽帧{status} {video_path.name}: "
                f"{max(1, int(sample_total_frames))} frames, {max(0.0, sample_elapsed_seconds):.1f}s"
            )

        def on_sample_progress(frame_index: int, total_frames: int, timestamp: float):
            nonlocal sample_started, sample_completed, sample_total_frames, sample_elapsed_seconds
            raise_if_cancelled(cancel_file)
            total = max(1, int(total_frames or video_total_frames))
            current = min(max(0, int(frame_index)), total)
            sample_started = True
            sample_total_frames = total
            sample_elapsed_seconds = max(0.0, float(timestamp or 0.0))
            sample_completed = current >= total
            sample_ratio = min(1.0, current / total)
            emit_progress(
                "index",
                index_units_done + sample_ratio * video_units * 0.5,
                index_units_total,
                f"动态抽帧 {index}/{len(videos)}：{video_path.name} {current}/{total} 帧",
                current,
                total,
                f"当前视频：{video_path.name} · 动态抽帧",
            )

        def on_embed_progress(done: int, total: int):
            raise_if_cancelled(cancel_file)
            total = max(1, int(total))
            done = min(max(0, int(done)), total)
            embed_ratio = min(1.0, done / total)
            emit_progress(
                "index",
                index_units_done + video_units * 0.5 + embed_ratio * video_units * 0.5,
                index_units_total,
                f"提取特征 {index}/{len(videos)}：{video_path.name} {done}/{total} 帧",
                done,
                total,
                f"当前视频：{video_path.name} · 提取特征",
            )

        try:
            cache, embedder, cache_hit = ensure_video_indexed(
                video_path,
                cache_dir,
                args.skip_threshold,
                args.max_gap_sec,
                args.frame_step,
                resolved_device,
                embedder,
                args.force or force_feature_redo,
                preprocess_config,
                on_sample_progress,
                on_embed_progress,
                metrics,
            )
            from video_sim.candidate_selector import build_candidate_summary
            candidate_summaries[video_path] = build_candidate_summary(
                cache,
                representatives_per_video=64,
                max_index_frames_per_video=1024,
            )
            cache_artifacts[video_path] = FrameEmbeddingCache.get_cache_path(
                video_path,
                cache_dir,
                preprocess_config,
                skip_threshold=args.skip_threshold,
                max_gap_sec=args.max_gap_sec,
                frame_step=args.frame_step,
            )
            del cache
            gc.collect()
            if cache_hit:
                cache_hits += 1
            else:
                cache_rebuilds += 1
                emit_sample_log(True)
                cache_path = FrameEmbeddingCache.get_cache_path(
                    video_path,
                    cache_dir,
                    preprocess_config,
                    skip_threshold=args.skip_threshold,
                    max_gap_sec=args.max_gap_sec,
                    frame_step=args.frame_step,
                )
                record_task_cache_artifact(
                    cache_path,
                    f"视频 {video_path.name} 的抽帧与特征缓存；同配置增量任务可以复用",
                )
            index_units_done += video_units
            emit_progress(
                "index",
                index_units_done,
                index_units_total,
                f"索引完成 {index}/{len(videos)}：{video_path.name}",
                1,
                1,
                f"当前视频：{video_path.name} · 索引完成",
            )
        except AnalysisCancelled:
            raise
        except Exception as e:
            if is_video_decode_failure(e):
                original_path = video_path.resolve()
                destination_path = None
                move_error = ""
                try:
                    destination_path = quarantine_video(video_path, error_video_dir)
                    record_quarantine(
                        error_video_dir,
                        original_path,
                        destination_path,
                        str(e),
                    )
                except OSError as error:
                    move_error = compact_error(error)
                index_quarantined.add(video_path)
                removed_videos += 1
                remaining_videos = len(videos) - len(index_quarantined)
                emit_video_quarantined(
                    original_path,
                    destination_path or error_video_dir,
                    remaining_videos,
                    removed_videos,
                    moved=destination_path is not None,
                )
                if destination_path is not None:
                    print(
                        f"错误视频：{original_path}；原因：{compact_error(e)}；"
                        f"已移动到data/error_videos目录：{destination_path}；"
                        f"已移出比较列表，剩余 {remaining_videos} 个视频。",
                        file=sys.stderr,
                        flush=True,
                    )
                else:
                    print(
                        f"错误视频：{original_path}；原因：{compact_error(e)}；"
                        f"移动到data/error_videos目录失败：{move_error}；"
                        f"已移出比较列表，剩余 {remaining_videos} 个视频。",
                        file=sys.stderr,
                        flush=True,
                    )
                index_units_done += video_units
                continue
            if not sample_log_emitted:
                if sample_completed:
                    emit_sample_log(True)
                else:
                    emit_sample_log(False, str(e))
            warning_msg = f"Failed to index video: path={display_path(video_path)}; reason={e}"
            log(f"\nWarning: {warning_msg}")
            warnings.append(warning_msg)
            index_units_done += video_units
            emit_progress(
                "index",
                index_units_done,
                index_units_total,
                f"跳过失败视频 {index}/{len(videos)}：{video_path.name}",
                1,
                1,
                f"当前视频：{video_path.name} · 处理失败",
            )

    if index_quarantined:
        videos = [video_path for video_path in videos if video_path not in index_quarantined]

    log(f"\n成功索引 {len(candidate_summaries)}/{len(videos)} 个视频(Successfully indexed {len(candidate_summaries)}/{len(videos)} videos)")
    if len(candidate_summaries) < 2:
        log(
            "Error: Fewer than 2 valid videos remain after decoding and indexing; "
            "comparison cannot continue."
        )
        sys.exit(1)
    raise_if_cancelled(cancel_file)
    if finish_stage_only("features"):
        return

    # Generate output path if not specified
    if args.output:
        output_base = Path(args.output)
        # Remove extension for base path
        output_base = output_base.parent / output_base.stem
    else:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_base = cache_dir / "reports" / f"batch_report_{timestamp}"

    output_base.parent.mkdir(parents=True, exist_ok=True)
    resume_signature = build_resume_signature(videos, args, preprocess_config, resolved_device)
    state_path = task_state_path(cache_dir, task_id)
    if args.target_stage == "compare" and args.redo_stage:
        clear_resume_pairs(state_path, resume_signature)
    resume_state = load_resume_state(state_path, resume_signature)
    resumed_pair_count = len(resume_state.get("pairs", {}))
    if resumed_pair_count:
        log(f"断点续跑(Resume checkpoint): {resumed_pair_count} 个已完成视频对可用")

    log("正在加载报告模块(Loading report module)...")
    from video_sim.reporter import BatchReportData, write_csv_report, write_html_report, write_json_report

    # Create report data
    report_data = BatchReportData(
        timestamp=datetime.now().isoformat(),
    )
    for w in warnings:
        report_data.add_warning(w)

    # Perform pairwise comparison
    indexed_videos = list(candidate_summaries.keys())
    emit_candidate_progress(0, max(1, len(indexed_videos)), "正在进行全局候选粗筛")
    from video_sim.candidate_selector import select_candidate_pairs
    from video_sim.indexer import configure_faiss_thread_budget

    candidate_faiss_threads = configure_faiss_thread_budget(compare_workers=1)
    log(f"候选筛选 FAISS 线程预算(Candidate FAISS thread budget): {candidate_faiss_threads}")

    def on_candidate_progress(done: int, total: int, label: str):
        raise_if_cancelled(cancel_file)
        emit_candidate_progress(
            done,
            total,
            f"候选粗筛 {done}/{total}：{label}",
            done,
            total,
            label,
        )

    with metrics.stage("candidate", items=len(indexed_videos)):
        candidate_selection = select_candidate_pairs(
            candidate_summaries,
            candidate_limit=max(0, int(args.candidate_limit)),
            match_threshold=args.match_threshold,
            representatives_per_video=64,
            max_index_frames_per_video=1024,
            progress_callback=on_candidate_progress,
        )
    metrics.set_count("videos", len(indexed_videos))
    metrics.set_count("candidate_pairs", len(candidate_selection.pairs))
    summary_bytes = sum(
        int(
            summary.timestamps.nbytes
            + summary.optimized_source_representatives.nbytes
            + summary.optimized_index_embeddings.nbytes
            + summary.auxiliary_signatures.nbytes
        )
        for summary in candidate_summaries.values()
    )
    metrics.set_count("candidate_summary_bytes", summary_bytes)
    # Exact comparison will reload full caches through the pool. Drop all
    # candidate-only arrays before scheduling those leases; keep only scalar
    # frame counts/durations and artifact paths for progress/reporting.
    for summary in candidate_summaries.values():
        summary.timestamps = np.zeros((0,), dtype="float32")
        summary.optimized_source_representatives = np.zeros((0, 0), dtype="float32")
        summary.optimized_index_embeddings = np.zeros((0, 0), dtype="float32")
        summary.auxiliary_signatures = np.zeros((0,), dtype="uint64")
    gc.collect()
    video_pairs = candidate_selection.pairs
    total_pairs = len(video_pairs)
    report_data.total_possible_pairs = candidate_selection.all_pair_count
    report_data.candidate_pairs = total_pairs
    report_data.skipped_by_candidate_screening = candidate_selection.skipped_pair_count
    if candidate_selection.skipped_pair_count:
        reduction = candidate_selection.skipped_pair_count / max(1, candidate_selection.all_pair_count)
        log(
            "Candidate screening: "
            f"{total_pairs}/{candidate_selection.all_pair_count} pairs retained, "
            f"{candidate_selection.skipped_pair_count} obvious low-probability pairs skipped "
            f"({reduction:.1%} reduction)"
        )
    else:
        log(f"候选筛选已禁用(Candidate screening disabled): 将比较全部 {total_pairs} 对视频")
    candidate_pair_keys = {
        pair_key(video_a, video_b)
        for video_a, video_b in video_pairs
    }
    resumed_candidate_pairs = {
        key
        for key in resume_state.get("pairs", {})
        if key in candidate_pair_keys
    }
    start_task_manifest(
        state_path.parent / "task.json",
        task_id,
        input_dir,
        indexed_videos,
        total_pairs,
        len(resumed_candidate_pairs),
        args.task_match_key,
        task_config,
        output_base,
    )
    emit_candidate_progress(
        max(1, len(indexed_videos)),
        max(1, len(indexed_videos)),
        f"候选粗筛完成：保留 {total_pairs}/{candidate_selection.all_pair_count} 对",
    )
    if finish_stage_only("candidate"):
        return
    log(f"\n正在比较 {total_pairs} 对视频(Comparing {total_pairs} video pairs)...")
    log(f"缓存命中(Cache hits): {cache_hits}，重建(rebuilt): {cache_rebuilds}")

    emit_progress("compare", 0, max(total_pairs, 1), "加载视频比对模块")
    from video_sim.matcher import compare_frame_indexes_bidirectional
    from video_sim.segmenter import aggregate_bidirectional_segments, fixed_window_similarity
    from video_sim.resource_pool import ExactResourcePool

    pair_units = {
        pair_key(video_a, video_b): float(
            max(
                1,
                candidate_summaries[video_a].frame_count
                + candidate_summaries[video_b].frame_count,
            )
        )
        for video_a, video_b in video_pairs
    }
    compare_units_total = max(1.0, sum(pair_units.values()))
    compare_units_done = sum(
        pair_units[key]
        for key in resumed_candidate_pairs
        if key in pair_units
    )
    completed_pair_count = len(resumed_candidate_pairs)
    failed_pair_count = 0
    if completed_pair_count:
        emit_progress(
            "compare",
            compare_units_done,
            compare_units_total,
            f"已恢复 {completed_pair_count}/{total_pairs} 个视频对，继续分析",
            completed_pair_count,
            max(1, total_pairs),
            "恢复历史比较进度",
        )

    compare_workers = max(1, min(8, int(args.compare_workers or 1)))
    early_stop_enabled = not bool(args.disable_early_stop)
    log(
        f"精确比较工作线程(Exact comparison workers): {compare_workers}；"
        f"保守早停(conservative early-stop)已{'启用' if early_stop_enabled else '禁用'}。"
    )
    exact_faiss_threads = configure_faiss_thread_budget(
        compare_workers=compare_workers
    )
    log(f"精确比较 FAISS 线程预算(Exact FAISS thread budget): {exact_faiss_threads}")
    configured_pool_cap = os.environ.get("VIDEO_SIM_EXACT_CACHE_VIDEOS", "").strip()
    requested_pool_cap = int(configured_pool_cap) if configured_pool_cap.isdigit() else 0
    exact_pool = ExactResourcePool(
        max_resident_videos=max(2, compare_workers * 2, requested_pool_cap)
    )

    def compare_leased_pair(cache_a, index_a, cache_b, index_b, progress_callback):
        total_frames_a = max(1, len(cache_a.embeddings))
        total_frames_b = max(1, len(cache_b.embeddings))
        with metrics.stage("exact_compare", items=total_frames_a + total_frames_b):
            result = compare_frame_indexes_bidirectional(
                cache_a=cache_a,
                cache_b=cache_b,
                index_a=index_a,
                index_b=index_b,
                match_threshold=args.match_threshold,
                top_k=args.top_k,
                progress_callback=progress_callback,
                early_stop=early_stop_enabled,
            )
        duration_a = cache_duration_seconds(cache_a)
        duration_b = cache_duration_seconds(cache_b)
        windows_a_to_b = fixed_window_similarity(
            result.matches_a_to_b,
            window_size=args.window_size,
            total_source_duration=duration_a,
            source_timestamps=cache_a.timestamps,
        )
        windows_b_to_a = fixed_window_similarity(
            result.matches_b_to_a,
            window_size=args.window_size,
            total_source_duration=duration_b,
            source_timestamps=cache_b.timestamps,
        )
        with metrics.stage(
            "segment",
            items=len(result.matches_a_to_b) + len(result.matches_b_to_a),
        ):
            segments = aggregate_bidirectional_segments(
                result.matches_a_to_b,
                result.matches_b_to_a,
                source_timestamps_a=cache_a.timestamps,
                source_timestamps_b=cache_b.timestamps,
                total_source_duration_a=duration_a,
                total_source_duration_b=duration_b,
                min_segment_duration=args.min_segment_duration,
                min_segment_matches=args.min_segment_matches,
                offset_tolerance_sec=args.offset_tolerance,
            )
        return result, segments, windows_a_to_b, windows_b_to_a

    if compare_workers > 1:
        progress_lock = Lock()
        in_flight_pair_units: dict[str, float] = {}

        def compute_exact_pair(
            pair_index: int,
            video_a: Path,
            video_b: Path,
            current_pair_key: str,
            current_pair_units: float,
            pair_sub_label: str,
        ):
            total_frames_a = max(1, candidate_summaries[video_a].frame_count)
            total_frames_b = max(1, candidate_summaries[video_b].frame_count)

            def on_parallel_compare_progress(direction: str, done: int, total: int):
                raise_if_cancelled(cancel_file)
                pair_done, pair_total_frames, direction_label = comparison_sub_progress(
                    direction,
                    done,
                    total,
                    total_frames_a,
                    total_frames_b,
                    None if early_stop_enabled else "a_to_b",
                )
                pair_fraction = min(1.0, max(0.0, pair_done / max(1, pair_total_frames)))
                with progress_lock:
                    in_flight_pair_units[current_pair_key] = current_pair_units * pair_fraction
                    aggregate_done = min(
                        compare_units_total,
                        compare_units_done + sum(in_flight_pair_units.values()),
                    )
                    aggregate_pairs = min(
                        float(max(1, total_pairs)),
                        completed_pair_count + sum(
                            min(1.0, max(0.0, value / max(pair_units.get(key, 1.0), 1.0)))
                            for key, value in in_flight_pair_units.items()
                        ),
                    )
                emit_progress(
                    "compare",
                    aggregate_done,
                    compare_units_total,
                    f"并行比较 {pair_index}/{total_pairs}：{video_a.name} / {video_b.name} · {direction_label} {done}/{max(1, int(total))} 帧",
                    aggregate_pairs,
                    max(1, total_pairs),
                    pair_sub_label,
                )

            with exact_pool.acquire_pair(
                cache_artifacts[video_a], cache_artifacts[video_b]
            ) as (resource_a, resource_b):
                return compare_leased_pair(
                    resource_a.cache,
                    resource_a.frame_index,
                    resource_b.cache,
                    resource_b.frame_index,
                    on_parallel_compare_progress,
                )

        def store_parallel_pair(current_pair_key: str, payload):
            result, segments, windows_a_to_b, windows_b_to_a = payload
            report_data.add_pair_result(
                result=result,
                segments=[s.to_dict() for s in segments],
                windows_a_to_b=[w.to_dict() for w in windows_a_to_b],
                windows_b_to_a=[w.to_dict() for w in windows_b_to_a],
            )
            if report_data.video_pairs:
                report_data.video_pairs[-1]["preprocess_config"] = preprocess_config.to_dict()
                report_data.video_pairs[-1]["match_threshold"] = args.match_threshold
                resume_state.setdefault("pairs", {})[current_pair_key] = report_data.video_pairs[-1]
                try:
                    save_resume_pair(
                        state_path,
                        resume_signature,
                        current_pair_key,
                        report_data.video_pairs[-1],
                    )
                except OSError as checkpoint_error:
                    log(f"警告(Warning): 保存断点续跑检查点失败: {compact_error(checkpoint_error)}")

        with ThreadPoolExecutor(max_workers=compare_workers) as executor:
            future_meta = {}
            pair_iterator = iter(enumerate(video_pairs, start=1))
            pairs_exhausted = False
            max_in_flight = max(compare_workers, compare_workers * 4)

            while future_meta or not pairs_exhausted:
                while not pairs_exhausted and len(future_meta) < max_in_flight:
                    raise_if_cancelled(cancel_file)
                    try:
                        pair_index, (video_a, video_b) = next(pair_iterator)
                    except StopIteration:
                        pairs_exhausted = True
                        break

                    current_pair_key = pair_key(video_a, video_b)
                    current_pair_units = pair_units[current_pair_key]
                    cached_pair = resume_state.get("pairs", {}).get(current_pair_key)
                    if cached_pair:
                        report_data.video_pairs.append(cached_pair)
                        log(f"  Resume pair {pair_index}/{total_pairs}: {video_a.name} / {video_b.name}")
                        continue

                    pair_sub_label = f"当前比较：{video_a.name} ↔ {video_b.name}"
                    future = executor.submit(
                        compute_exact_pair,
                        pair_index,
                        video_a,
                        video_b,
                        current_pair_key,
                        current_pair_units,
                        pair_sub_label,
                    )
                    future_meta[future] = (
                        pair_index,
                        video_a,
                        video_b,
                        current_pair_key,
                        current_pair_units,
                        pair_sub_label,
                    )

                if not future_meta:
                    continue

                completed_futures, _ = wait(
                    tuple(future_meta),
                    return_when=FIRST_COMPLETED,
                )
                for future in completed_futures:
                    pair_index, video_a, video_b, current_pair_key, current_pair_units, pair_sub_label = future_meta.pop(future)
                    try:
                        raise_if_cancelled(cancel_file)
                        result = future.result()
                        store_parallel_pair(current_pair_key, result)
                        with progress_lock:
                            in_flight_pair_units.pop(current_pair_key, None)
                            compare_units_done += current_pair_units
                            completed_pair_count += 1
                        processed_pair_count = completed_pair_count + failed_pair_count
                        update_task_manifest(
                            completedPairs=processed_pair_count,
                            failedPairs=failed_pair_count,
                            progress=round(processed_pair_count / max(1, total_pairs) * 100.0, 2),
                            stage=f"已处理视频对 {processed_pair_count}/{total_pairs}",
                        )
                        emit_progress(
                            "compare",
                            compare_units_done,
                            compare_units_total,
                            f"完成比较 {pair_index}/{total_pairs}：{video_a.name} / {video_b.name}",
                            1,
                            1,
                            f"{pair_sub_label} · 比较完成",
                        )
                    except AnalysisCancelled:
                        raise
                    except Exception as e:
                        failed_pair_count += 1
                        warning_msg = (
                            "Failed to compare videos: "
                            f"video_a={display_path(video_a)}; "
                            f"video_b={display_path(video_b)}; "
                            f"reason={e}"
                        )
                        log(f"\nWarning: {warning_msg}")
                        report_data.add_warning(warning_msg)
                        with progress_lock:
                            in_flight_pair_units.pop(current_pair_key, None)
                            compare_units_done += current_pair_units
                        processed_pair_count = completed_pair_count + failed_pair_count
                        update_task_manifest(
                            completedPairs=processed_pair_count,
                            failedPairs=failed_pair_count,
                            progress=round(processed_pair_count / max(1, total_pairs) * 100.0, 2),
                            stage=f"已处理视频对 {processed_pair_count}/{total_pairs}，失败 {failed_pair_count} 对",
                        )
                        emit_progress(
                            "compare",
                            compare_units_done,
                            compare_units_total,
                            f"跳过失败比较 {pair_index}/{total_pairs}：{video_a.name} / {video_b.name}",
                            1,
                            1,
                            f"{pair_sub_label} · 比较失败",
                        )

        video_pairs = []

    for pair_index, (video_a, video_b) in enumerate(video_pairs, start=1):
        raise_if_cancelled(cancel_file)
        current_pair_key = pair_key(video_a, video_b)
        current_pair_units = pair_units[current_pair_key]
        pair_sub_label = f"当前比较：{video_a.name} ↔ {video_b.name}"
        emit_progress(
            "compare",
            compare_units_done,
            compare_units_total,
            f"比较视频对 {pair_index}/{total_pairs}：{video_a.name} / {video_b.name}",
            0,
            1,
            pair_sub_label,
        )
        cached_pair = resume_state.get("pairs", {}).get(current_pair_key)
        if cached_pair:
            report_data.video_pairs.append(cached_pair)
            log(f"  Resume pair {pair_index}/{total_pairs}: {video_a.name} / {video_b.name}")
            continue

        try:
            total_frames_a = max(1, candidate_summaries[video_a].frame_count)
            total_frames_b = max(1, candidate_summaries[video_b].frame_count)

            def on_compare_progress(direction: str, done: int, total: int):
                raise_if_cancelled(cancel_file)
                pair_done, pair_total_frames, direction_label = comparison_sub_progress(
                    direction,
                    done,
                    total,
                    total_frames_a,
                    total_frames_b,
                    None if early_stop_enabled else "a_to_b",
                )
                emit_progress(
                    "compare",
                    compare_units_done + (pair_done / pair_total_frames) * current_pair_units,
                    compare_units_total,
                    f"比较视频对 {pair_index}/{total_pairs}：{video_a.name} / {video_b.name} · {direction_label} {min(max(0, int(done)), max(1, int(total)))}/{max(1, int(total))} 帧",
                    pair_done,
                    pair_total_frames,
                    pair_sub_label,
                )

            with exact_pool.acquire_pair(
                cache_artifacts[video_a], cache_artifacts[video_b]
            ) as (resource_a, resource_b):
                result, segments, windows_a_to_b, windows_b_to_a = compare_leased_pair(
                    resource_a.cache,
                    resource_a.frame_index,
                    resource_b.cache,
                    resource_b.frame_index,
                    on_compare_progress,
                )

            # Add to report
            report_data.add_pair_result(
                result=result,
                segments=[s.to_dict() for s in segments],
                windows_a_to_b=[w.to_dict() for w in windows_a_to_b],
                windows_b_to_a=[w.to_dict() for w in windows_b_to_a],
            )
            if report_data.video_pairs:
                report_data.video_pairs[-1]["preprocess_config"] = preprocess_config.to_dict()
                report_data.video_pairs[-1]["match_threshold"] = args.match_threshold
                resume_state.setdefault("pairs", {})[current_pair_key] = report_data.video_pairs[-1]
                try:
                    save_resume_pair(
                        state_path,
                        resume_signature,
                        current_pair_key,
                        report_data.video_pairs[-1],
                    )
                except OSError as checkpoint_error:
                    log(f"警告(Warning): 保存断点续跑检查点失败: {compact_error(checkpoint_error)}")
            compare_units_done += current_pair_units
            completed_pair_count += 1
            processed_pair_count = completed_pair_count + failed_pair_count
            update_task_manifest(
                completedPairs=processed_pair_count,
                failedPairs=failed_pair_count,
                progress=round(processed_pair_count / max(1, total_pairs) * 100.0, 2),
                stage=f"已处理视频对 {processed_pair_count}/{total_pairs}",
            )
            emit_progress(
                "compare",
                compare_units_done,
                compare_units_total,
                f"完成比较 {pair_index}/{total_pairs}：{video_a.name} / {video_b.name}",
                1,
                1,
                f"{pair_sub_label} · 比较完成",
            )

        except AnalysisCancelled:
            raise
        except Exception as e:
            failed_pair_count += 1
            warning_msg = (
                "Failed to compare videos: "
                f"video_a={display_path(video_a)}; "
                f"video_b={display_path(video_b)}; "
                f"reason={e}"
            )
            log(f"\nWarning: {warning_msg}")
            report_data.add_warning(warning_msg)
            compare_units_done += current_pair_units
            processed_pair_count = completed_pair_count + failed_pair_count
            update_task_manifest(
                completedPairs=processed_pair_count,
                failedPairs=failed_pair_count,
                progress=round(processed_pair_count / max(1, total_pairs) * 100.0, 2),
                stage=f"已处理视频对 {processed_pair_count}/{total_pairs}，失败 {failed_pair_count} 对",
            )
            emit_progress(
                "compare",
                compare_units_done,
                compare_units_total,
                f"跳过失败比较 {pair_index}/{total_pairs}：{video_a.name} / {video_b.name}",
                1,
                1,
                f"{pair_sub_label} · 比较失败",
            )

    emit_progress(
        "compare",
        compare_units_total,
        compare_units_total,
        f"两两比较完成：{len(report_data.video_pairs)}/{total_pairs} 对",
        len(report_data.video_pairs),
        max(1, total_pairs),
        "比较断点已保存",
    )
    if finish_stage_only("compare"):
        return

    # Write reports
    emit_progress("report", 0, 1, "写入分析报告")
    log("\n正在写入报告(Writing reports)...")
    for stat_name, stat_value in exact_pool.stats().items():
        metrics.set_count(f"exact_pool_{stat_name}", stat_value)
    report_data.metrics = metrics.to_dict()

    json_path = output_base.with_suffix(".json")
    write_json_report(report_data, json_path)
    log(f"  JSON: {json_path}")

    csv_path = output_base.with_suffix(".csv")
    write_csv_report(report_data, csv_path)
    log(f"  CSV:  {csv_path}")

    html_path = output_base.with_suffix(".html")
    write_html_report(report_data, html_path)
    log(f"  HTML: {html_path}")
    emit_progress("report", 1, 1, "报告写入完成")

    # Summary
    log("\n" + "=" * 60)
    log("批量比较汇总(Batch Comparison Summary)")
    log("=" * 60)
    log(f"已索引视频(Videos indexed): {len(candidate_summaries)}")
    log(f"缓存命中(Cache hits): {cache_hits}")
    log(f"缓存重建(Cache rebuilt): {cache_rebuilds}")
    log(f"已比较视频对(Pairs compared): {len(report_data.video_pairs)}")
    log(
        "候选对(Candidate pairs): "
        f"{total_pairs}/{candidate_selection.all_pair_count} "
        f"(单视频上限(limit per video): {candidate_selection.candidate_limit or 'all'})"
    )
    log(f"警告(Warnings): {len(report_data.warnings)}")

    # Count by relation
    relations = {}
    for pair in report_data.video_pairs:
        rel = pair["relation"]
        relations[rel] = relations.get(rel, 0) + 1

    log("\n发现的关系(Relations found):")
    for rel, count in sorted(relations.items(), key=lambda x: -x[1]):
        log(f"  {rel}: {count}")

    log("=" * 60)
    update_task_manifest(
        status="completed",
        completedPairs=total_pairs,
        failedPairs=failed_pair_count,
        progress=100.0,
        stage=f"分析完成，{failed_pair_count} 对失败" if failed_pair_count else "分析完成",
        reportJson=_portable_path(json_path),
        reportCsv=_portable_path(csv_path),
        reportHtml=_portable_path(html_path),
    )
    emit_progress("done", 1, 1, "分析完成")


if __name__ == "__main__":
    try:
        main()
    except AnalysisCancelled as exc:
        active_stage = str(ACTIVE_TASK_MANIFEST.get("activeStage") or "")
        if active_stage:
            stage = next(
                (item for item in merge_task_stages(ACTIVE_TASK_MANIFEST.get("stages")) if item["id"] == active_stage),
                None,
            )
            update_task_stage(
                active_stage,
                "paused",
                float(stage.get("progress") or 0.0) if stage else 0.0,
                "阶段已暂停，可继续执行",
            )
        update_task_manifest(status="paused", stage="任务已暂停，可从历史任务继续")
        log(str(exc))
        sys.exit(130)
    except Exception:
        active_stage = str(ACTIVE_TASK_MANIFEST.get("activeStage") or "")
        if active_stage:
            stage = next(
                (item for item in merge_task_stages(ACTIVE_TASK_MANIFEST.get("stages")) if item["id"] == active_stage),
                None,
            )
            update_task_stage(
                active_stage,
                "failed",
                float(stage.get("progress") or 0.0) if stage else 0.0,
                "阶段执行失败，可检查日志后重试",
            )
        update_task_manifest(status="failed", stage="任务异常中断，可检查日志后继续")
        raise
