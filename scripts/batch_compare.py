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
import hashlib
import json
import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))


def log(message: str) -> None:
    print(message, flush=True)


def display_path(path: Path) -> str:
    try:
        return str(path.resolve())
    except OSError:
        return str(path)


def progress_text(value: str) -> str:
    return str(value).replace("|", "／")


def compact_error(value: str) -> str:
    text = " ".join(str(value).replace("|", "／").split())
    if not text:
        return "未知错误"
    return text[:160] + ("..." if len(text) > 160 else "")


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


def probe_video_frame_count(video_path: Path) -> int:
    try:
        from decord import VideoReader, cpu

        return max(1, int(len(VideoReader(str(video_path), ctx=cpu(0), num_threads=1))))
    except Exception:
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
        "containment_scoring_version": 3,
        "videos": [file_fingerprint(path) for path in videos],
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
        "crop_black_borders": preprocess_config.crop_black_borders,
        "resize_mode": preprocess_config.resize_mode.value,
        "input_size": preprocess_config.input_size,
        "portrait_rotation": preprocess_config.portrait_rotation.value,
        "device": resolved_device,
    }


def pair_key(video_a: Path, video_b: Path) -> str:
    left, right = sorted([str(video_a.resolve()), str(video_b.resolve())])
    return f"{left}||{right}"


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
        log(f"Migrating {len(state['pairs'])} legacy resume pairs to incremental SQLite checkpoint...")
        try:
            save_resume_pairs(state_path, signature, state["pairs"])
        except OSError as migration_error:
            log(f"Warning: Failed to migrate resume pairs: {compact_error(migration_error)}")
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


def resume_pair_database_path(state_path: Path, signature: dict) -> Path:
    signature_json = json.dumps(signature, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    signature_hash = hashlib.sha256(signature_json.encode("utf-8")).hexdigest()[:16]
    return state_path.with_name(f"{state_path.stem}.pairs-{signature_hash}.sqlite3")


def resume_pair_store_dir(state_path: Path, signature: dict) -> Path:
    signature_json = json.dumps(signature, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    signature_hash = hashlib.sha256(signature_json.encode("utf-8")).hexdigest()[:16]
    return state_path.with_name(f"{state_path.stem}.pairs-{signature_hash}")


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
    from video_sim.embedder import FrameEmbeddingCache, VideoEmbedder, embed_frames_with_cache
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
        )
        if cache is not None:
            log(f"  Cache hit: {video_path.name}")
            log(f"  Cache file: {cache_path}")
            return cache, embedder, True
        if cache_path.exists():
            log(f"  Cache stale, rebuilding: {cache_path}")
        else:
            legacy_path = FrameEmbeddingCache.get_legacy_cache_path(
                video_path,
                cache_dir,
                preprocess_config,
            )
            if legacy_path.exists():
                log(f"  Legacy cache lacks validation metadata and will be rebuilt: {legacy_path}")

    if force and cache_path.exists():
        log(f"  Force enabled, regenerating: {video_path.name}")

    sampler = DynamicFrameSampler(
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
        cache_dir=cache_dir,
        preprocess_config=preprocess_config,
    )
    retained_frames = sampler.sample(video_path, progress_callback=progress_callback)

    if len(retained_frames) == 0:
        raise ValueError(f"No frames retained from {video_path}")

    if embedder is None:
        log("Initializing embedder...")
        embedder = VideoEmbedder(device=device, preprocess_config=preprocess_config)

    log(f"  Extracting embeddings: {video_path.name}")
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
        progress_callback=embed_progress_callback,
    )
    log(f"  Saved cache: {cache_path}")

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
        "--cancel-file",
        type=str,
        default="",
        help="Path to a cancellation flag file created by the desktop app",
    )
    # Add preprocessing arguments
    add_preprocess_args(parser)
    args = parser.parse_args()

    emit_progress("scan", 0, 1, "加载视频扫描模块")
    from video_sim.preprocess import PreprocessConfig
    from video_sim.scanner import scan_videos

    # Create preprocess config
    preprocess_config = PreprocessConfig.from_args(args)
    cancel_file = Path(args.cancel_file) if args.cancel_file else None

    input_dir = Path(args.input)
    cache_dir = Path(args.cache_dir)
    raise_if_cancelled(cancel_file)

    if not input_dir.exists():
        log(f"Error: Input directory not found: {input_dir}")
        sys.exit(1)

    # Scan for videos
    emit_progress("scan", 0, 1, "扫描视频目录")
    log(f"Scanning for videos in: {input_dir}")
    videos = scan_videos(input_dir, recursive=True)
    raise_if_cancelled(cancel_file)

    if len(videos) < 2:
        log(f"Error: Need at least 2 videos for comparison, found {len(videos)}")
        sys.exit(1)

    log(f"Found {len(videos)} videos")
    video_frame_counts = {}
    for probe_index, video_path in enumerate(videos, start=1):
        raise_if_cancelled(cancel_file)
        emit_progress(
            "scan",
            probe_index - 1,
            len(videos),
            f"读取视频信息 {probe_index}/{len(videos)}：{video_path.name}",
            probe_index - 1,
            len(videos),
            "读取视频帧数",
        )
        video_frame_counts[video_path] = probe_video_frame_count(video_path)
    emit_progress(
        "scan",
        len(videos),
        len(videos),
        f"扫描完成：找到 {len(videos)} 个视频",
        len(videos),
        len(videos),
        "视频信息读取完成",
    )

    # Resolve device
    emit_progress("model", 0, 1, "准备运行设备")
    if args.device == "auto":
        import torch
        resolved_device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        resolved_device = args.device
    log(f"Device: {resolved_device}")
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

    # Load CLIP lazily. Valid caches can skip model initialization entirely.
    emit_progress("model", 0, 1, "检查视频缓存，必要时按需加载 CLIP 模型")
    log("Model loading is lazy: valid cached videos skip CLIP initialization.")
    embedder = None
    emit_progress("model", 1, 1, "缓存检查准备完成")

    # Index all videos
    log("\nIndexing videos...")
    video_caches = {}
    cache_hits = 0
    cache_rebuilds = 0
    warnings = []
    index_video_units = {
        video_path: max(1, int(video_frame_counts.get(video_path, 1))) * 2.0
        for video_path in videos
    }
    index_units_total = max(1.0, sum(index_video_units.values()))
    index_units_done = 0.0

    for index, video_path in enumerate(videos, start=1):
        raise_if_cancelled(cancel_file)
        video_units = index_video_units[video_path]
        video_total_frames = max(1, int(video_frame_counts.get(video_path, 1)))
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
                args.force,
                preprocess_config,
                on_sample_progress,
                on_embed_progress,
            )
            video_caches[video_path] = cache
            if cache_hit:
                cache_hits += 1
            else:
                cache_rebuilds += 1
                emit_sample_log(True)
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

    log(f"\nSuccessfully indexed {len(video_caches)}/{len(videos)} videos")
    raise_if_cancelled(cancel_file)

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
    state_path = resume_state_path(output_base.parent, input_dir, resume_signature)
    resume_state = load_resume_state(state_path, resume_signature)
    resumed_pair_count = len(resume_state.get("pairs", {}))
    if resumed_pair_count:
        log(f"Resume checkpoint: {resumed_pair_count} completed video pairs available")

    log("Loading report module...")
    from video_sim.reporter import BatchReportData, write_csv_report, write_html_report, write_json_report

    # Create report data
    report_data = BatchReportData(
        timestamp=datetime.now().isoformat(),
    )
    for w in warnings:
        report_data.add_warning(w)

    # Perform pairwise comparison
    indexed_videos = list(video_caches.keys())
    emit_candidate_progress(0, max(1, len(indexed_videos)), "正在进行全局候选粗筛")
    from video_sim.candidate_selector import select_candidate_pairs

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

    candidate_selection = select_candidate_pairs(
        video_caches,
        candidate_limit=max(0, int(args.candidate_limit)),
        match_threshold=args.match_threshold,
        progress_callback=on_candidate_progress,
    )
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
        log(f"Candidate screening disabled: comparing all {total_pairs} video pairs")
    emit_candidate_progress(
        max(1, len(indexed_videos)),
        max(1, len(indexed_videos)),
        f"候选粗筛完成：保留 {total_pairs}/{candidate_selection.all_pair_count} 对",
    )
    log(f"\nComparing {total_pairs} video pairs...")
    log(f"Cache hits: {cache_hits}, rebuilt: {cache_rebuilds}")

    emit_progress("compare", 0, max(total_pairs, 1), "加载视频比对模块")
    from video_sim.indexer import build_frame_index
    from video_sim.matcher import compare_frame_indexes_bidirectional
    from video_sim.segmenter import aggregate_segments, fixed_window_similarity

    frame_indexes = {}
    for frame_index, video_path in enumerate(indexed_videos, start=1):
        raise_if_cancelled(cancel_file)
        log(f"  Building frame index {frame_index}/{len(indexed_videos)}: {video_path.name}")
        frame_indexes[video_path] = build_frame_index(video_caches[video_path])

    pair_units = {
        pair_key(video_a, video_b): float(max(1, len(video_caches[video_a].embeddings) + len(video_caches[video_b].embeddings)))
        for video_a, video_b in video_pairs
    }
    compare_units_total = max(1.0, sum(pair_units.values()))
    compare_units_done = 0.0

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
            compare_units_done += current_pair_units
            emit_progress(
                "compare",
                compare_units_done,
                compare_units_total,
                f"跳过已完成视频对 {pair_index}/{total_pairs}：{video_a.name} / {video_b.name}",
                1,
                1,
                f"{pair_sub_label} · 已完成缓存",
            )
            continue

        try:
            cache_a = video_caches[video_a]
            cache_b = video_caches[video_b]
            pair_total_frames = max(1, len(cache_a.embeddings) + len(cache_b.embeddings))
            a_query_total = max(1, len(cache_a.embeddings))

            def on_compare_progress(direction: str, done: int, total: int):
                raise_if_cancelled(cancel_file)
                total = max(1, int(total))
                done = min(max(0, int(done)), total)
                pair_done = done if direction == "a_to_b" else a_query_total + done
                pair_done = min(pair_done, pair_total_frames)
                direction_label = "A→B" if direction == "a_to_b" else "B→A"
                emit_progress(
                    "compare",
                    compare_units_done + (pair_done / pair_total_frames) * current_pair_units,
                    compare_units_total,
                    f"比较视频对 {pair_index}/{total_pairs}：{video_a.name} / {video_b.name} · {direction_label} {done}/{total} 帧",
                    pair_done,
                    pair_total_frames,
                    pair_sub_label,
                )

            # Perform bidirectional comparison
            result = compare_frame_indexes_bidirectional(
                cache_a=cache_a,
                cache_b=cache_b,
                index_a=frame_indexes[video_a],
                index_b=frame_indexes[video_b],
                match_threshold=args.match_threshold,
                top_k=args.top_k,
                progress_callback=on_compare_progress,
            )

            # Compute directional window similarity so A→B and B→A are not mixed.
            duration_a = cache_a.timestamps[-1] if len(cache_a.timestamps) > 0 else 0
            duration_b = cache_b.timestamps[-1] if len(cache_b.timestamps) > 0 else 0
            windows_a_to_b = fixed_window_similarity(
                result.matches_a_to_b,
                window_size=args.window_size,
                total_source_duration=duration_a,
            )
            windows_b_to_a = fixed_window_similarity(
                result.matches_b_to_a,
                window_size=args.window_size,
                total_source_duration=duration_b,
            )

            # Aggregate segments
            all_matches = result.matches_a_to_b + result.matches_b_to_a
            segments = aggregate_segments(
                all_matches,
                min_segment_duration=args.min_segment_duration,
                min_segment_matches=args.min_segment_matches,
                offset_tolerance_sec=args.offset_tolerance,
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
                    log(f"Warning: Failed to save resume checkpoint: {compact_error(checkpoint_error)}")
            compare_units_done += current_pair_units
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
            warning_msg = (
                "Failed to compare videos: "
                f"video_a={display_path(video_a)}; "
                f"video_b={display_path(video_b)}; "
                f"reason={e}"
            )
            log(f"\nWarning: {warning_msg}")
            report_data.add_warning(warning_msg)
            compare_units_done += current_pair_units
            emit_progress(
                "compare",
                compare_units_done,
                compare_units_total,
                f"跳过失败比较 {pair_index}/{total_pairs}：{video_a.name} / {video_b.name}",
                1,
                1,
                f"{pair_sub_label} · 比较失败",
            )

    # Write reports
    emit_progress("report", 0, 1, "写入分析报告")
    log("\nWriting reports...")

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
    log("Batch Comparison Summary")
    log("=" * 60)
    log(f"Videos indexed: {len(video_caches)}")
    log(f"Cache hits: {cache_hits}")
    log(f"Cache rebuilt: {cache_rebuilds}")
    log(f"Pairs compared: {len(report_data.video_pairs)}")
    log(
        "Candidate pairs: "
        f"{len(video_pairs)}/{candidate_selection.all_pair_count} "
        f"(limit per video: {candidate_selection.candidate_limit or 'all'})"
    )
    log(f"Warnings: {len(report_data.warnings)}")

    # Count by relation
    relations = {}
    for pair in report_data.video_pairs:
        rel = pair["relation"]
        relations[rel] = relations.get(rel, 0) + 1

    log("\nRelations found:")
    for rel, count in sorted(relations.items(), key=lambda x: -x[1]):
        log(f"  {rel}: {count}")

    log("=" * 60)
    emit_progress("done", 1, 1, "分析完成")


if __name__ == "__main__":
    try:
        main()
    except AnalysisCancelled as exc:
        log(str(exc))
        sys.exit(130)
