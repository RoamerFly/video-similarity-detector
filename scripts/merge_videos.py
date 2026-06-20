#!/usr/bin/env python3
"""Merge, resize, crop, trim, and split videos with FFmpeg."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
from collections import deque
from datetime import datetime
from pathlib import Path


ACTIVE_PROCESS: subprocess.Popen | None = None


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit_progress(progress: float, stage: str) -> None:
    safe_stage = str(stage).replace("|", "／").replace("\r", " ").replace("\n", " ")
    print(f"MERGE_PROGRESS|{max(0.0, min(100.0, progress)):.2f}|{safe_stage}", flush=True)


def resolve_ffmpeg(project_root: Path) -> str:
    executable_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    candidates = [
        os.environ.get("VIDEO_SIM_FFMPEG", "").strip(),
        str(project_root / "tools" / executable_name),
        str(project_root / "env" / executable_name),
        str(project_root / "env" / "python" / "Scripts" / executable_name),
        str(project_root / "env" / "python" / "bin" / executable_name),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate

    try:
        import imageio_ffmpeg

        candidate = imageio_ffmpeg.get_ffmpeg_exe()
        if candidate and Path(candidate).is_file():
            return candidate
    except Exception:
        pass

    candidate = shutil.which("ffmpeg")
    if candidate:
        return candidate
    raise RuntimeError(
        "未找到 FFmpeg。请重新构建带 imageio-ffmpeg 的运行环境，"
        "或把 ffmpeg 放到 exe 同级 tools 目录。"
    )


def probe_video(ffmpeg: str, path: Path) -> dict:
    process = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    text = process.stderr or ""
    duration_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    video_match = re.search(
        r"Stream\s+#\S+.*?Video:.*?(\d{2,5})x(\d{2,5})(?:[\s,\[]|$)",
        text,
        flags=re.IGNORECASE,
    )
    if not duration_match or not video_match:
        raise RuntimeError(f"无法读取视频信息: {path}")

    hours, minutes, seconds = duration_match.groups()
    duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    return {
        "duration": max(0.01, duration),
        "width": int(video_match.group(1)),
        "height": int(video_match.group(2)),
        "has_audio": bool(re.search(r"Stream\s+#\S+.*?Audio:", text, flags=re.IGNORECASE)),
    }

def probe_audio(ffmpeg: str, path: Path) -> dict:
    process = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    text = process.stderr or ""
    duration_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if not duration_match or not re.search(r"Stream\s+#\S+.*?Audio:", text, flags=re.IGNORECASE):
        raise RuntimeError(f"无法读取音频信息: {path}")
    hours, minutes, seconds = duration_match.groups()
    return {"duration": max(0.01, int(hours) * 3600 + int(minutes) * 60 + float(seconds))}


def even(value: int, minimum: int = 2) -> int:
    numeric = max(minimum, int(value))
    return numeric if numeric % 2 == 0 else numeric - 1


def number(value, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def safe_stem(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value.strip())
    cleaned = cleaned.rstrip(". ")
    return cleaned or f"merged_{datetime.now().strftime('%Y%m%d_%H%M%S')}"


def unique_output_path(output_dir: Path, stem: str, suffix: str = ".mp4") -> Path:
    candidate = output_dir / f"{stem}{suffix}"
    if not candidate.exists():
        return candidate
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return output_dir / f"{stem}_{timestamp}{suffix}"


def unique_output_stem(output_dir: Path, stem: str) -> str:
    if not (output_dir / f"{stem}.mp4").exists() and not any(output_dir.glob(f"{stem}_*.mp4")):
        return stem
    return f"{stem}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"


def build_video_filter(
    index: int,
    metadata: dict,
    item: dict,
    config: dict,
) -> tuple[str, float, float, float]:
    duration = metadata["duration"]
    start = max(0.0, min(number(item.get("trimStart")), duration - 0.01))
    requested_end = number(item.get("trimEnd"))
    end = duration if requested_end <= start else min(requested_end, duration)
    clip_duration = max(0.01, end - start)
    filters = [f"[{index}:v:0]trim=start={start:.6f}:end={end:.6f}", "setpts=PTS-STARTPTS"]

    rotation = int(number(item.get("rotation"))) % 360
    if rotation == 90:
        filters.append("transpose=clock")
    elif rotation == 180:
        filters.extend(["hflip", "vflip"])
    elif rotation == 270:
        filters.append("transpose=cclock")
    else:
        rotation = 0

    if item.get("cropEnabled"):
        source_width = metadata["height"] if rotation in {90, 270} else metadata["width"]
        source_height = metadata["width"] if rotation in {90, 270} else metadata["height"]
        crop_x = max(0, int(number(item.get("cropX"))))
        crop_y = max(0, int(number(item.get("cropY"))))
        crop_width = int(number(item.get("cropWidth"), source_width))
        crop_height = int(number(item.get("cropHeight"), source_height))
        crop_x = min(crop_x, max(0, source_width - 2))
        crop_y = min(crop_y, max(0, source_height - 2))
        crop_width = even(min(max(2, crop_width), source_width - crop_x))
        crop_height = even(min(max(2, crop_height), source_height - crop_y))
        filters.append(f"crop={crop_width}:{crop_height}:{crop_x}:{crop_y}")

    width = even(int(number(config.get("width"), 1920)))
    height = even(int(number(config.get("height"), 1080)))
    fit_mode = config.get("fitMode", "contain")
    if fit_mode == "cover":
        filters.extend([
            f"scale={width}:{height}:force_original_aspect_ratio=increase",
            f"crop={width}:{height}",
        ])
    elif fit_mode == "stretch":
        filters.append(f"scale={width}:{height}")
    else:
        background = "white" if config.get("canvasBackground") == "white" else "black"
        filters.extend([
            f"scale={width}:{height}:force_original_aspect_ratio=decrease",
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={background}",
        ])

    fps = max(1, min(120, int(number(config.get("fps"), 30))))
    filters.extend([f"fps={fps}", "setsar=1", "format=yuv420p"])
    return ",".join(filters) + f"[v{index}]", start, end, clip_duration


def build_audio_filter(
    index: int,
    metadata: dict,
    start: float,
    end: float,
    duration: float,
    muted: bool = False,
) -> str:
    if metadata["has_audio"] and not muted:
        return (
            f"[{index}:a:0]atrim=start={start:.6f}:end={end:.6f},"
            "asetpts=PTS-STARTPTS,aresample=48000,"
            f"aformat=sample_fmts=fltp:channel_layouts=stereo[a{index}]"
        )
    return (
        "anullsrc=channel_layout=stereo:sample_rate=48000,"
        f"atrim=duration={duration:.6f},asetpts=PTS-STARTPTS[a{index}]"
    )


def prepare_video_items(inputs: list[dict], metadata: list[dict]) -> list[dict]:
    prepared: list[dict] = []
    sequential_cursors: dict[int, float] = {}
    for index, (item, info) in enumerate(zip(inputs, metadata)):
        duration = info["duration"]
        source_start = max(0.0, min(number(item.get("trimStart")), duration - 0.01))
        requested_end = number(item.get("trimEnd"))
        source_end = duration if requested_end <= source_start else min(requested_end, duration)
        clip_duration = max(0.01, source_end - source_start)
        track_index = max(0, int(number(item.get("trackIndex"))))
        requested_timeline_start = item.get("startTime")
        if requested_timeline_start is None:
            timeline_start = sequential_cursors.get(track_index, 0.0)
        else:
            timeline_start = max(0.0, number(requested_timeline_start))
        timeline_end = timeline_start + clip_duration
        sequential_cursors[track_index] = max(sequential_cursors.get(track_index, 0.0), timeline_end)
        prepared.append({
            "input_index": index,
            "item": item,
            "metadata": info,
            "source_start": source_start,
            "source_end": source_end,
            "duration": clip_duration,
            "timeline_start": timeline_start,
            "timeline_end": timeline_end,
            "track_index": track_index,
        })
    return prepared


def timeline_intervals(prepared: list[dict]) -> list[dict]:
    boundaries = sorted({
        round(value, 6)
        for clip in prepared
        for value in (clip["timeline_start"], clip["timeline_end"])
    })
    intervals: list[dict] = []
    for start, end in zip(boundaries, boundaries[1:]):
        if end - start <= 0.000001:
            continue
        midpoint = (start + end) / 2.0
        active = [
            clip for clip in prepared
            if clip["timeline_start"] <= midpoint < clip["timeline_end"]
        ]
        if not active:
            continue
        active.sort(key=lambda clip: (clip["track_index"], clip["input_index"]))
        intervals.append({"start": start, "end": end, "active": active})
    return intervals


def grid_cells(count: int, width: int, height: int) -> list[tuple[int, int, int, int]]:
    if count <= 1:
        return [(0, 0, width, height)]
    columns = 2 if count <= 4 else 3
    rows = (count + columns - 1) // columns
    cell_width = even(width // columns)
    cell_height = even(height // rows)
    cells = []
    for index in range(count):
        column = index % columns
        row = index // columns
        cells.append((column * cell_width, row * cell_height, cell_width, cell_height))
    return cells


def layout_cells(
    clips: list[dict],
    width: int,
    height: int,
) -> list[tuple[int, int, int, int]]:
    if not clips:
        return []
    if len(clips) == 1:
        return [(0, 0, width, height)]
    if not all(bool(clip["item"].get("layoutCustom")) for clip in clips):
        return grid_cells(len(clips), width, height)
    cells = []
    for clip in clips:
        item = clip["item"]
        cell_width = even(max(2, int(number(item.get("layoutWidth"), 1.0) * width)))
        cell_height = even(max(2, int(number(item.get("layoutHeight"), 1.0) * height)))
        x = max(0, min(width - cell_width, int(number(item.get("layoutX")) * width)))
        y = max(0, min(height - cell_height, int(number(item.get("layoutY")) * height)))
        cells.append((x, y, cell_width, cell_height))
    return cells


def append_rotation_and_crop(filters: list[str], metadata: dict, item: dict) -> None:
    rotation = int(number(item.get("rotation"))) % 360
    if rotation == 90:
        filters.append("transpose=clock")
    elif rotation == 180:
        filters.extend(["hflip", "vflip"])
    elif rotation == 270:
        filters.append("transpose=cclock")
    else:
        rotation = 0

    if not item.get("cropEnabled"):
        return
    source_width = metadata["height"] if rotation in {90, 270} else metadata["width"]
    source_height = metadata["width"] if rotation in {90, 270} else metadata["height"]
    crop_x = max(0, int(number(item.get("cropX"))))
    crop_y = max(0, int(number(item.get("cropY"))))
    crop_width = int(number(item.get("cropWidth"), source_width))
    crop_height = int(number(item.get("cropHeight"), source_height))
    crop_x = min(crop_x, max(0, source_width - 2))
    crop_y = min(crop_y, max(0, source_height - 2))
    crop_width = even(min(max(2, crop_width), source_width - crop_x))
    crop_height = even(min(max(2, crop_height), source_height - crop_y))
    filters.append(f"crop={crop_width}:{crop_height}:{crop_x}:{crop_y}")


def append_cell_fit(filters: list[str], width: int, height: int, config: dict) -> None:
    fit_mode = config.get("fitMode", "contain")
    background = "white" if config.get("canvasBackground") == "white" else "black"
    if fit_mode == "cover":
        filters.extend([
            f"scale={width}:{height}:force_original_aspect_ratio=increase",
            f"crop={width}:{height}",
        ])
    elif fit_mode == "stretch":
        filters.append(f"scale={width}:{height}")
    else:
        filters.extend([
            f"scale={width}:{height}:force_original_aspect_ratio=decrease",
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={background}",
        ])


def build_timeline_filter_graph(
    inputs: list[dict],
    metadata: list[dict],
    audio_tracks: list[dict],
    audio_metadata: list[dict],
    config: dict,
) -> tuple[list[str], float, bool]:
    prepared = prepare_video_items(inputs, metadata)
    if not prepared:
        raise RuntimeError("时间线至少需要一个视频片段。")
    total_duration = max(clip["timeline_end"] for clip in prepared)
    intervals = timeline_intervals(prepared)
    width = even(int(number(config.get("width"), 1920)))
    height = even(int(number(config.get("height"), 1080)))
    fps = max(1, min(120, int(number(config.get("fps"), 30))))
    background = "white" if config.get("canvasBackground") == "white" else "black"
    filters: list[str] = []

    branch_counts = {
        clip["input_index"]: sum(clip in interval["active"] for interval in intervals)
        for clip in prepared
    }
    source_labels: dict[int, deque[str]] = {}
    for clip in prepared:
        index = clip["input_index"]
        count = branch_counts[index]
        if count <= 1:
            source_labels[index] = deque([f"[{index}:v:0]"])
            continue
        labels = [f"vsrc{index}_{branch}" for branch in range(count)]
        filters.append(f"[{index}:v:0]split={count}{''.join(f'[{label}]' for label in labels)}")
        source_labels[index] = deque(f"[{label}]" for label in labels)

    filters.append(f"color=c={background}:s={width}x{height}:r={fps}:d={total_duration:.6f}[canvas0]")
    overlay_index = 0
    segment_index = 0
    for interval in intervals:
        cells = layout_cells(interval["active"], width, height)
        for clip, (x, y, cell_width, cell_height) in zip(interval["active"], cells):
            source_offset = interval["start"] - clip["timeline_start"]
            source_start = clip["source_start"] + source_offset
            source_end = source_start + (interval["end"] - interval["start"])
            chain = [
                f"{source_labels[clip['input_index']].popleft()}trim=start={source_start:.6f}:end={source_end:.6f}",
                "setpts=PTS-STARTPTS",
            ]
            append_rotation_and_crop(chain, clip["metadata"], clip["item"])
            append_cell_fit(chain, cell_width, cell_height, config)
            chain.extend([
                f"fps={fps}",
                "setsar=1",
                "format=yuv420p",
                f"setpts=PTS+{interval['start']:.6f}/TB[vseg{segment_index}]",
            ])
            filters.append(",".join(chain))
            filters.append(
                f"[canvas{overlay_index}][vseg{segment_index}]"
                f"overlay=x={x}:y={y}:eof_action=pass:shortest=0[canvas{overlay_index + 1}]"
            )
            overlay_index += 1
            segment_index += 1
    filters.append(f"[canvas{overlay_index}]trim=duration={total_duration:.6f},format=yuv420p[vout]")

    audio_labels: list[str] = []
    if bool(config.get("includeAudio", True)):
        for clip in prepared:
            if not clip["metadata"]["has_audio"] or bool(clip["item"].get("muted", False)):
                continue
            label = f"clipa{clip['input_index']}"
            delay_ms = max(0, int(clip["timeline_start"] * 1000))
            filters.append(
                f"[{clip['input_index']}:a:0]"
                f"atrim=start={clip['source_start']:.6f}:end={clip['source_end']:.6f},"
                "asetpts=PTS-STARTPTS,aresample=48000,"
                "aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"adelay={delay_ms}:all=1[{label}]"
            )
            audio_labels.append(f"[{label}]")

    for audio_index, (item, info) in enumerate(zip(audio_tracks, audio_metadata)):
        input_index = len(inputs) + audio_index
        source_start = max(0.0, min(number(item.get("trimStart")), info["duration"] - 0.01))
        requested_end = number(item.get("trimEnd"))
        source_end = info["duration"] if requested_end <= source_start else min(requested_end, info["duration"])
        delay_ms = max(0, int(number(item.get("startTime")) * 1000))
        label = f"externala{audio_index}"
        filters.append(
            f"[{input_index}:a:0]atrim=start={source_start:.6f}:end={source_end:.6f},"
            "asetpts=PTS-STARTPTS,aresample=48000,"
            "aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"adelay={delay_ms}:all=1[{label}]"
        )
        audio_labels.append(f"[{label}]")

    if audio_labels:
        filters.append(
            f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:duration=longest:normalize=0,"
            f"atrim=duration={total_duration:.6f},asetpts=PTS-STARTPTS[aout]"
        )
    return filters, total_duration, bool(audio_labels)


def drain_stderr(stream, tail: deque[str]) -> None:
    for line in iter(stream.readline, ""):
        cleaned = line.rstrip()
        if cleaned:
            tail.append(cleaned)
            log(cleaned)
    stream.close()


def run_merge(config: dict, result_path: Path, project_root: Path) -> None:
    global ACTIVE_PROCESS

    ffmpeg = resolve_ffmpeg(project_root)
    inputs = config.get("inputs") or []
    if not inputs:
        raise RuntimeError("时间线至少需要一个视频片段。")

    metadata = []
    for index, item in enumerate(inputs, start=1):
        path = Path(str(item.get("path", "")))
        if not path.is_file():
            raise RuntimeError(f"视频文件不存在: {path}")
        emit_progress(index / len(inputs) * 8.0, f"读取视频信息 {index}/{len(inputs)}：{path.name}")
        metadata.append(probe_video(ffmpeg, path))

    output_dir = Path(str(config.get("outputDir", ""))).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)
    output_stem = safe_stem(str(config.get("outputName", "")))
    split_mode = str(config.get("splitMode", "none"))
    include_audio = bool(config.get("includeAudio", True))
    audio_tracks = config.get("audioTracks") or []

    command = [ffmpeg, "-hide_banner", "-y"]
    for item in inputs:
        command.extend(["-i", str(Path(str(item["path"])))])
    audio_metadata = []
    for item in audio_tracks:
        path = Path(str(item.get("path", "")))
        if not path.is_file():
            raise RuntimeError(f"音频文件不存在: {path}")
        command.extend(["-i", str(path)])
        audio_metadata.append(probe_audio(ffmpeg, path))

    filters, total_duration, output_has_audio = build_timeline_filter_graph(
        inputs,
        metadata,
        audio_tracks,
        audio_metadata,
        config,
    )

    command.extend(["-filter_complex", ";".join(filters), "-map", "[vout]"])
    if output_has_audio:
        command.extend(["-map", "[aout]"])
    command.extend([
        "-c:v", "libx264",
        "-preset", str(config.get("encoderPreset", "medium")),
        "-crf", str(max(0, min(51, int(number(config.get("crf"), 23))))),
        "-pix_fmt", "yuv420p",
    ])
    if output_has_audio:
        command.extend(["-c:a", "aac", "-b:a", "192k"])
    command.extend(["-map_metadata", "-1", "-progress", "pipe:1", "-nostats"])

    if split_mode in {"duration", "count"}:
        split_value = max(1.0, number(config.get("splitValue"), 600))
        segment_time = total_duration / split_value if split_mode == "count" else split_value
        segment_time = max(1.0, segment_time)
        output_stem = unique_output_stem(output_dir, output_stem)
        output_pattern = output_dir / f"{output_stem}_%03d.mp4"
        command.extend([
            "-force_key_frames", f"expr:gte(t,n_forced*{segment_time:.6f})",
            "-f", "segment",
            "-segment_time", f"{segment_time:.6f}",
            "-reset_timestamps", "1",
            str(output_pattern),
        ])
        expected_pattern = f"{output_stem}_*.mp4"
    else:
        output_path = unique_output_path(output_dir, output_stem)
        command.extend(["-movflags", "+faststart", str(output_path)])
        expected_pattern = output_path.name

    emit_progress(10.0, f"开始合并 {len(inputs)} 个视频")
    stderr_tail: deque[str] = deque(maxlen=30)
    ACTIVE_PROCESS = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    stderr_thread = threading.Thread(
        target=drain_stderr,
        args=(ACTIVE_PROCESS.stderr, stderr_tail),
        daemon=True,
    )
    stderr_thread.start()

    assert ACTIVE_PROCESS.stdout is not None
    for line in iter(ACTIVE_PROCESS.stdout.readline, ""):
        key, _, value = line.strip().partition("=")
        if key in {"out_time_us", "out_time_ms"}:
            try:
                elapsed = float(value) / 1_000_000.0
            except ValueError:
                continue
            progress = 10.0 + min(1.0, elapsed / max(0.01, total_duration)) * 88.0
            emit_progress(progress, f"正在合并：{elapsed:.1f}s / {total_duration:.1f}s")
        elif key == "progress" and value == "end":
            emit_progress(99.0, "正在整理输出文件")

    exit_code = ACTIVE_PROCESS.wait()
    stderr_thread.join(timeout=3)
    ACTIVE_PROCESS = None
    if exit_code != 0:
        details = "\n".join(stderr_tail)
        raise RuntimeError(f"FFmpeg 合并失败，退出码 {exit_code}：{details[-1800:]}")

    outputs = sorted(output_dir.glob(expected_pattern))
    if not outputs:
        raise RuntimeError("FFmpeg 已结束，但没有找到输出文件。")
    payload = {
        "outputPaths": [str(path.resolve()) for path in outputs],
        "message": f"已生成 {len(outputs)} 个视频文件",
    }
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    emit_progress(100.0, payload["message"])


def terminate_active_process(_signum, _frame) -> None:
    global ACTIVE_PROCESS
    if ACTIVE_PROCESS is not None and ACTIVE_PROCESS.poll() is None:
        ACTIVE_PROCESS.terminate()
        try:
            ACTIVE_PROCESS.wait(timeout=5)
        except subprocess.TimeoutExpired:
            ACTIVE_PROCESS.kill()
    raise SystemExit(130)


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge videos with FFmpeg")
    parser.add_argument("--config", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--project-root", required=True)
    args = parser.parse_args()

    signal.signal(signal.SIGINT, terminate_active_process)
    signal.signal(signal.SIGTERM, terminate_active_process)
    config_path = Path(args.config)
    result_path = Path(args.result)
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    run_merge(config, result_path, Path(args.project_root))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        log(str(error))
        raise SystemExit(1)
