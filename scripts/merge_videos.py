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
import tempfile
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from queue import Empty, Queue


ACTIVE_PROCESS: subprocess.Popen | None = None
MAX_DYNAMIC_COMPOSITOR_SEGMENTS = 1600
MIN_DYNAMIC_COMPOSITOR_SEGMENTS = 120
REFERENCE_COMPOSITOR_PIXELS = 1920 * 1080


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit_progress(progress: float, stage: str) -> None:
    safe_stage = str(stage).replace("|", "／").replace("\r", " ").replace("\n", " ")
    print(f"MERGE_PROGRESS|{max(0.0, min(100.0, progress)):.2f}|{safe_stage}", flush=True)


def dynamic_compositor_budget(width: int, height: int, metadata: list[dict]) -> int:
    """Scale graph complexity to the largest frame that FFmpeg must retain."""
    largest_pixels = max(
        width * height,
        *(max(1, int(info.get("width", 0))) * max(1, int(info.get("height", 0))) for info in metadata),
    )
    return max(
        MIN_DYNAMIC_COMPOSITOR_SEGMENTS,
        min(MAX_DYNAMIC_COMPOSITOR_SEGMENTS, int(MAX_DYNAMIC_COMPOSITOR_SEGMENTS * REFERENCE_COMPOSITOR_PIXELS / largest_pixels)),
    )


def merge_thread_limits(
    input_count: int,
    width: int = 0,
    height: int = 0,
    *,
    pixel_count: int | None = None,
) -> tuple[int, int]:
    """Bound FFmpeg workers while reserving CPU time for the desktop UI.

    A high-resolution filter graph is memory-bound long before it is CPU-bound:
    every additional filter worker can retain another full-size frame.  Keep
    the existing CPU-aware budget for normal exports, but deliberately reduce
    concurrency for UHD/8K work so exporting remains responsive instead of
    exhausting the machine.
    """
    cores = max(1, os.cpu_count() or 1)
    reserved_cores = 2 if cores >= 4 else 1
    available_cores = max(1, cores - reserved_cores)
    decoder_threads = 1 if input_count >= 2 else min(2, available_cores)
    active_decoder_budget = max(1, min(input_count, 4)) * decoder_threads
    pipeline_budget = max(1, available_cores - active_decoder_budget)
    # Filtering and encoding run concurrently, so each receives only half of
    # the remaining budget rather than independently saturating every core.
    filter_threads = max(1, min(4, pipeline_budget // 2))
    pixels = max(1, int(pixel_count or max(0, width) * max(0, height)))
    if pixels >= 3840 * 2160:
        filter_threads = 1
    elif pixels >= 2560 * 1440:
        filter_threads = min(filter_threads, 2)
    return decoder_threads, filter_threads


def merge_memory_limits(pixel_count: int) -> tuple[int, int]:
    """Return bounded input and filter-graph queues for the output size.

    FFmpeg otherwise allows several demux packets and filter frames to be in
    flight per input.  With seven 4K inputs that multiplies into a very large
    resident set.  Small queues intentionally trade a little throughput for a
    predictable memory ceiling; the filter graph can still make progress as
    frames are consumed.
    """
    pixels = max(1, int(pixel_count))
    if pixels >= 7680 * 4320:
        return 2, 16
    if pixels >= 3840 * 2160:
        # concat/overlay need a small amount of look-ahead; values below 14
        # make FFmpeg abort with AVERROR(ENOMEM) even when the host still has
        # free RAM.  Sixteen frames is the smallest reliable bound for a
        # seven-input UHD timeline in the bundled FFmpeg.
        return 4, 16
    if pixels >= 2560 * 1440:
        return 6, 12
    if pixels >= 1920 * 1080:
        return 8, 8
    return 12, 12


def ffmpeg_creation_flags() -> int:
    if os.name != "nt":
        return 0
    return (
        subprocess.CREATE_NO_WINDOW
        | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0x00004000)
    )


def ffmpeg_startup_info():
    """Hide console windows even when a packaged FFmpeg briefly allocates one."""
    if os.name != "nt":
        return None
    startup_info = subprocess.STARTUPINFO()
    startup_info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup_info.wShowWindow = subprocess.SW_HIDE
    return startup_info


def resolve_ffmpeg(project_root: Path) -> str:
    executable_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    candidates = [
        os.environ.get("VIDEO_SIM_FFMPEG", "").strip(),
        str(project_root / "tools" / executable_name),
        str(project_root / "merge-env" / executable_name),
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
        "未找到 FFmpeg。请重新构建带独立 FFmpeg 的运行环境，"
        "或把 ffmpeg 放到应用 merge-env、env 或 tools 目录。"
    )


def probe_video(ffmpeg: str, path: Path) -> dict:
    process = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=ffmpeg_creation_flags(),
        startupinfo=ffmpeg_startup_info(),
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
        creationflags=ffmpeg_creation_flags(),
        startupinfo=ffmpeg_startup_info(),
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


def escape_drawtext(value: str) -> str:
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace(":", "\\:")
        .replace(",", "\\,")
        .replace("%", "\\%")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
        .replace("\r", "\\n")
    )


def resolve_drawtext_font_file() -> str | None:
    """Return a concrete system font so drawtext never needs fontconfig lookup.

    The packaged FFmpeg runtime is intentionally self-contained and may not have
    a Fontconfig installation.  Supplying an existing font file also makes text
    rendering deterministic across the desktop and avoids noisy
    ``Cannot load default config file`` diagnostics.
    """
    configured = os.environ.get("VIDEO_SIM_FONT_FILE", "").strip()
    candidates = [configured] if configured else []
    if os.name == "nt":
        windows_root = os.environ.get("WINDIR") or os.environ.get("SystemRoot")
        windows_fonts = Path(windows_root) / "Fonts" if windows_root else None
        if windows_fonts:
            candidates.extend([
                str(windows_fonts / "msyh.ttc"),
                str(windows_fonts / "simhei.ttf"),
                str(windows_fonts / "segoeui.ttf"),
                str(windows_fonts / "arial.ttf"),
            ])
        candidates.extend([
            r"C:\Windows\Fonts\msyh.ttc",     # Microsoft YaHei (CJK)
            r"C:\Windows\Fonts\simhei.ttf",   # SimHei (CJK)
            r"C:\Windows\Fonts\segoeui.ttf",
            r"C:\Windows\Fonts\arial.ttf",
        ])
    elif sys.platform == "darwin":
        candidates.extend([
            "/System/Library/Fonts/PingFang.ttc",
            "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
            "/Library/Fonts/Arial.ttf",
        ])
    else:
        candidates.extend([
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        ])
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate).expanduser()
        if path.is_file():
            # FFmpeg's filter parser accepts forward slashes on every platform;
            # escaping the drive-letter colon is handled by escape_drawtext.
            return path.resolve().as_posix()
    return None


def drawtext_fontfile_option(font_file: str | None) -> str:
    if not font_file:
        return ""
    return f"fontfile='{escape_drawtext(font_file)}':"


def ffmpeg_color(value: str, fallback: str) -> str:
    text = str(value or "").strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
        return "0x" + text[1:]
    rgba = re.fullmatch(
        r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)",
        text,
    )
    if rgba:
        red, green, blue, alpha = rgba.groups()
        red_i = max(0, min(255, int(red)))
        green_i = max(0, min(255, int(green)))
        blue_i = max(0, min(255, int(blue)))
        alpha_value = max(0.0, min(1.0, float(alpha) if alpha is not None else 1.0))
        return f"0x{red_i:02x}{green_i:02x}{blue_i:02x}@{alpha_value:.3f}"
    return fallback


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
    text_tracks = config.get("textTracks") or []
    text_end = max(
        [0.0]
        + [
            max(0.0, number(item.get("startTime"))) + max(0.05, number(item.get("duration"), 3.0))
            for item in text_tracks
            if str(item.get("text", "")).strip()
        ]
    )
    audio_end = max(
        [0.0]
        + [
            max(0.0, number(item.get("startTime")))
            + max(
                0.01,
                (
                    info["duration"] if number(item.get("trimEnd")) <= number(item.get("trimStart"))
                    else min(number(item.get("trimEnd")), info["duration"])
                ) - max(0.0, min(number(item.get("trimStart")), info["duration"] - 0.01)),
            )
            for item, info in zip(audio_tracks, audio_metadata)
            if not bool(item.get("muted", False))
        ]
    ) if bool(config.get("includeAudio", True)) else 0.0
    total_duration = max(max(clip["timeline_end"] for clip in prepared), text_end, audio_end)
    intervals = timeline_intervals(prepared)
    width = even(int(number(config.get("width"), 1920)))
    height = even(int(number(config.get("height"), 1080)))
    fps = max(1, min(120, int(number(config.get("fps"), 30))))
    background = "white" if config.get("canvasBackground") == "white" else "black"
    filters: list[str] = []
    drawtext_font_file = resolve_drawtext_font_file()

    # A non-overlapping edit can be represented as clips plus cheap color gap
    # sources.  The generic compositor below splits every input once per active
    # interval and retains a growing chain of full-resolution canvases; using a
    # concat graph here keeps only the current decoded streams alive.
    ordered_prepared = sorted(prepared, key=lambda clip: (clip["timeline_start"], clip["input_index"]))
    cursor = 0.0
    linear_non_overlapping = True
    for clip in ordered_prepared:
        if clip["timeline_start"] < cursor - 0.0005:
            linear_non_overlapping = False
            break
        cursor = max(cursor, clip["timeline_end"])
    # A multi-camera composition with custom cells that are present throughout
    # the timeline has a fixed geometry.  It can be overlaid once per input
    # instead of splitting every source at every interval boundary.
    static_custom_composition = (
        len(prepared) > 1
        and all(bool(clip["item"].get("layoutCustom")) for clip in prepared)
        and bool(intervals)
        and all(len(interval["active"]) > 1 for interval in intervals)
    )
    dynamic_compositor_segments = sum(len(interval["active"]) for interval in intervals)
    dynamic_budget = dynamic_compositor_budget(width, height, metadata)
    if not linear_non_overlapping and not static_custom_composition and dynamic_compositor_segments > dynamic_budget:
        raise RuntimeError(
            "多轨时间线过于复杂，预计需要处理 "
            f"{dynamic_compositor_segments} 个画面区间，已超过安全上限（当前分辨率上限 "
            f"{dynamic_budget}）。请拆分项目导出，或为持续画中画改用固定自定义布局。"
        )

    if linear_non_overlapping:
        labels = []
        cursor = 0.0
        gap_index = 0
        for clip in ordered_prepared:
            gap_duration = clip["timeline_start"] - cursor
            if gap_duration > 0.0005:
                gap_label = f"vgap{gap_index}"
                filters.append(
                    f"color=c={background}:s={width}x{height}:r={fps}:d={gap_duration:.6f},"
                    f"setsar=1,format=yuv420p[{gap_label}]"
                )
                labels.append(f"[{gap_label}]")
                gap_index += 1
            index = clip["input_index"]
            filter_text, _, _, _ = build_video_filter(index, clip["metadata"], clip["item"], config)
            filters.append(filter_text)
            labels.append(f"[v{index}]")
            cursor = clip["timeline_end"]
        if len(labels) == 1:
            filters.append(f"{labels[0]}null[vbase]")
        else:
            filters.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0[vbase]")
        if total_duration > cursor + 0.0005:
            filters.append(
                f"[vbase]tpad=stop_mode=add:stop_duration={total_duration - cursor:.6f}[vextended]"
            )
            text_input_label = "vextended"
        else:
            text_input_label = "vbase"
    elif static_custom_composition:
        cells = layout_cells(prepared, width, height)
        filters.append(f"color=c={background}:s={width}x{height}:r={fps}:d={total_duration:.6f}[canvas0]")
        for overlay_index, (clip, (x, y, cell_width, cell_height)) in enumerate(zip(prepared, cells)):
            chain = [
                f"[{clip['input_index']}:v:0]trim=start={clip['source_start']:.6f}:end={clip['source_end']:.6f}",
                "setpts=PTS-STARTPTS",
            ]
            append_rotation_and_crop(chain, clip["metadata"], clip["item"])
            append_cell_fit(chain, cell_width, cell_height, config)
            chain.extend([
                f"fps={fps}",
                "setsar=1",
                "format=yuv420p",
                f"setpts=PTS+{clip['timeline_start']:.6f}/TB[vstatic{overlay_index}]",
            ])
            filters.append(",".join(chain))
            filters.append(
                f"[canvas{overlay_index}][vstatic{overlay_index}]"
                f"overlay=x={x}:y={y}:eof_action=pass:repeatlast=0:shortest=0[canvas{overlay_index + 1}]"
            )
        text_input_label = f"canvas{len(prepared)}"
    else:
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
        text_input_label = f"canvas{overlay_index}"
    for text_index, item in enumerate(text_tracks):
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        start = max(0.0, number(item.get("startTime")))
        duration = max(0.05, number(item.get("duration"), 3.0))
        end = min(total_duration, start + duration)
        if end <= start:
            continue
        font_size = max(8, min(240, int(number(item.get("fontSize"), 48))))
        x_ratio = max(0.0, min(1.0, number(item.get("x"), 0.5)))
        y_ratio = max(0.0, min(1.0, number(item.get("y"), 0.82)))
        next_label = f"textcanvas{text_index}"
        filters.append(
            f"[{text_input_label}]drawtext="
            f"{drawtext_fontfile_option(drawtext_font_file)}"
            f"text='{escape_drawtext(text)}':"
            f"x=min(max(0\\,w*{x_ratio:.6f}-text_w/2)\\,w-text_w):"
            f"y=min(max(0\\,h*{y_ratio:.6f}-text_h/2)\\,h-text_h):"
            f"fontsize={font_size}:"
            f"fontcolor={ffmpeg_color(str(item.get('color', '')), 'white')}:"
            "box=1:"
            f"boxcolor={ffmpeg_color(str(item.get('backgroundColor', '')), 'black@0.45')}:"
            "boxborderw=12:"
            f"enable='between(t,{start:.6f},{end:.6f})'"
            f"[{next_label}]"
        )
        text_input_label = next_label
    preview_start = max(0.0, number(config.get("previewStart"), 0.0))
    requested_preview_duration = number(config.get("previewDuration"), 0.0)
    preview_duration = min(requested_preview_duration, max(0.0, total_duration - preview_start)) \
        if requested_preview_duration > 0.0 else total_duration
    if preview_duration <= 0.0:
        raise RuntimeError("所选预览范围没有可计算的视频内容。")
    if requested_preview_duration > 0.0:
        filters.append(
            f"[{text_input_label}]trim=start={preview_start:.6f}:duration={preview_duration:.6f},"
            "setpts=PTS-STARTPTS,format=yuv420p[vout]"
        )
    else:
        filters.append(f"[{text_input_label}]trim=duration={total_duration:.6f},format=yuv420p[vout]")

    audio_labels: list[str] = []
    if bool(config.get("includeAudio", True)):
        extracted_clip_ids = {
            str(item.get("sourceClipId"))
            for item in audio_tracks
            if item.get("sourceType") == "video" and item.get("sourceClipId")
        }
        for clip in prepared:
            if (
                not clip["metadata"]["has_audio"]
                or bool(clip["item"].get("muted", False))
                or str(clip["item"].get("id", "")) in extracted_clip_ids
            ):
                continue
            label = f"clipa{clip['input_index']}"
            delay_ms = max(0, int(clip["timeline_start"] * 1000))
            vol = number(clip["item"].get("volume"), 1.0)
            vol_filter = f"volume={vol:.2f}," if vol != 1.0 else ""
            filters.append(
                f"[{clip['input_index']}:a:0]"
                f"atrim=start={clip['source_start']:.6f}:end={clip['source_end']:.6f},"
                "asetpts=PTS-STARTPTS,aresample=48000,"
                "aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"{vol_filter}adelay={delay_ms}:all=1[{label}]"
            )
            audio_labels.append(f"[{label}]")

    if bool(config.get("includeAudio", True)):
        for audio_index, (item, info) in enumerate(zip(audio_tracks, audio_metadata)):
            if bool(item.get("muted", False)):
                continue
            input_index = int(number(item.get("_inputIndex"), len(inputs) + audio_index))
            source_start = max(0.0, min(number(item.get("trimStart")), info["duration"] - 0.01))
            requested_end = number(item.get("trimEnd"))
            source_end = info["duration"] if requested_end <= source_start else min(requested_end, info["duration"])
            delay_ms = max(0, int(number(item.get("startTime")) * 1000))
            label = f"externala{audio_index}"
            volume = max(0.0, min(3.0, number(item.get("volume"), 1.0)))
            volume_filter = f"volume={volume:.2f}," if volume != 1.0 else ""
            filters.append(
                f"[{input_index}:a:0]atrim=start={source_start:.6f}:end={source_end:.6f},"
                "asetpts=PTS-STARTPTS,aresample=48000,"
                "aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"{volume_filter}adelay={delay_ms}:all=1[{label}]"
            )
            audio_labels.append(f"[{label}]")

    if audio_labels:
        audio_trim = (
            f"atrim=start={preview_start:.6f}:duration={preview_duration:.6f}"
            if requested_preview_duration > 0.0
            else f"atrim=duration={total_duration:.6f}"
        )
        filters.append(
            f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:duration=longest:normalize=0,"
            f"{audio_trim},asetpts=PTS-STARTPTS[aout]"
        )
    return filters, preview_duration, bool(audio_labels)


def drain_stderr(stream, tail: deque[str]) -> None:
    for line in iter(stream.readline, ""):
        cleaned = line.rstrip()
        if cleaned:
            tail.append(cleaned)
            log(cleaned)
    stream.close()


def video_encoding_args(config: dict) -> list[str]:
    encoder = "libx265" if str(config.get("videoEncoder", "h264")).lower() == "h265" else "libx264"
    preset = str(config.get("encoderPreset", "medium")).lower()
    if preset not in {
        "ultrafast", "superfast", "veryfast", "faster", "fast",
        "medium", "slow", "slower", "veryslow",
    }:
        preset = "medium"
    args = ["-c:v", encoder, "-preset", preset]
    if str(config.get("rateControl", "quality")).lower() == "bitrate":
        bitrate = max(100, min(100000, int(number(config.get("videoBitrate"), 4000))))
        args.extend(["-b:v", f"{bitrate}k"])
    else:
        crf = max(0, min(51, int(number(config.get("crf"), 23))))
        args.extend(["-crf", str(crf)])
    args.extend(["-pix_fmt", "yuv420p"])
    return args


def audio_encoding_args(config: dict) -> list[str]:
    bitrate = max(32, min(512, int(number(config.get("audioBitrate"), 192))))
    return ["-c:a", "aac", "-b:a", f"{bitrate}k"]


def run_ffmpeg_command(
    command: list[str],
    total_duration: float,
    progress_start: float,
    progress_span: float,
    progress_stage: str,
) -> None:
    global ACTIVE_PROCESS

    input_count = sum(1 for argument in command if argument == "-i")
    output_name = Path(command[-1]).name if command else "-"
    log(f"启动 FFmpeg：{input_count} 个输入，输出 {output_name}")
    if os.environ.get("VIDEO_SIM_VERBOSE_MERGE", "").strip() == "1":
        log(f"FFmpeg command: {subprocess.list2cmdline(command)}")
    stderr_tail: deque[str] = deque(maxlen=30)
    emit_progress(progress_start, f"{progress_stage}：正在启动 FFmpeg，准备滤镜和编码器")
    ACTIVE_PROCESS = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=ffmpeg_creation_flags(),
        startupinfo=ffmpeg_startup_info(),
    )
    stderr_thread = threading.Thread(
        target=drain_stderr,
        args=(ACTIVE_PROCESS.stderr, stderr_tail),
        daemon=True,
    )
    stderr_thread.start()

    assert ACTIVE_PROCESS.stdout is not None
    progress_queue: Queue[str | None] = Queue()

    def drain_progress(stream) -> None:
        try:
            for progress_line in iter(stream.readline, ""):
                progress_queue.put(progress_line)
        finally:
            progress_queue.put(None)

    progress_thread = threading.Thread(
        target=drain_progress,
        args=(ACTIVE_PROCESS.stdout,),
        daemon=True,
    )
    progress_thread.start()

    last_progress_at = 0.0
    last_elapsed = -1.0
    last_reported_progress = progress_start
    last_heartbeat_at = 0.0
    startup_at = time.monotonic()
    progress_stream_closed = False
    while not progress_stream_closed:
        try:
            line = progress_queue.get(timeout=0.5)
        except Empty:
            now = time.monotonic()
            # FFmpeg does not emit out_time until the first decoded frame has
            # travelled through the complete graph.  On UHD inputs this can
            # take several seconds.  Report a bounded warm-up state so the UI
            # does not look frozen, while never pretending that real frames
            # have already been encoded.
            if last_elapsed < 0 and now - startup_at >= 0.8 and now - last_heartbeat_at >= 1.0:
                warmup_cap = min(1.5, max(0.5, progress_span * 0.03))
                warmup_progress = min(
                    progress_start + warmup_cap,
                    progress_start + (now - startup_at - 0.8) * 0.15,
                )
                if warmup_progress > last_reported_progress:
                    last_reported_progress = warmup_progress
                    emit_progress(
                        warmup_progress,
                        f"{progress_stage}：正在初始化解码器和滤镜（高分辨率可能需要更久）",
                    )
                last_heartbeat_at = now
            continue
        if line is None:
            progress_stream_closed = True
            continue
        key, _, value = line.strip().partition("=")
        if key in {"out_time_us", "out_time_ms"}:
            try:
                elapsed = float(value) / 1_000_000.0
            except ValueError:
                continue
            # Several FFmpeg versions emit both keys for the same timestamp.
            # Collapse duplicates and keep bridge/UI traffic comfortably below
            # the frame budget while the encoder is saturating the machine.
            if elapsed <= last_elapsed + 0.000001:
                continue
            now = time.monotonic()
            if now - last_progress_at < 0.2 and elapsed < total_duration - 0.02:
                last_elapsed = elapsed
                continue
            last_elapsed = elapsed
            last_progress_at = now
            progress = progress_start + min(1.0, elapsed / max(0.01, total_duration)) * progress_span
            progress = max(progress, last_reported_progress)
            last_reported_progress = progress
            emit_progress(progress, f"{progress_stage}：{elapsed:.1f}s / {total_duration:.1f}s")

    exit_code = ACTIVE_PROCESS.wait()
    progress_thread.join(timeout=3)
    stderr_thread.join(timeout=3)
    ACTIVE_PROCESS = None
    if exit_code != 0:
        details = "\n".join(stderr_tail)
        raise RuntimeError(f"FFmpeg 合并失败，退出码 {exit_code}：{details[-1800:]}")


def write_filter_graph(path: Path, filters: list[str]) -> None:
    """Store large filter graphs in a file to avoid platform command limits."""
    path.write_text(";".join(filters), encoding="utf-8")


def run_merge(config: dict, result_path: Path, project_root: Path) -> None:
    global ACTIVE_PROCESS

    ffmpeg = resolve_ffmpeg(project_root)
    inputs = config.get("inputs") or []
    if not inputs:
        raise RuntimeError("时间线至少需要一个视频片段。")

    metadata = []
    video_metadata_cache: dict[str, dict] = {}
    for index, item in enumerate(inputs, start=1):
        path = Path(str(item.get("path", "")))
        if not path.is_file():
            raise RuntimeError(f"视频文件不存在: {path}")
        emit_progress(index / len(inputs) * 8.0, f"读取视频信息 {index}/{len(inputs)}：{path.name}")
        cache_key = os.path.normcase(str(path.resolve()))
        info = video_metadata_cache.get(cache_key)
        if info is None:
            info = probe_video(ffmpeg, path)
            video_metadata_cache[cache_key] = info
        metadata.append(info)

    output_dir = Path(str(config.get("outputDir", ""))).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)
    output_stem = safe_stem(str(config.get("outputName", "")))
    split_mode = str(config.get("splitMode", "none"))
    include_audio = bool(config.get("includeAudio", True))
    audio_tracks = (config.get("audioTracks") or []) if include_audio else []

    video_input_index_by_id = {
        str(item.get("id")): index
        for index, item in enumerate(inputs)
        if item.get("id")
    }
    reusable_audio_indexes: dict[int, int] = {}
    extra_audio_input_count = 0
    for audio_index, item in enumerate(audio_tracks):
        if bool(item.get("muted", False)):
            continue
        source_clip_id = str(item.get("sourceClipId", ""))
        source_input_index = video_input_index_by_id.get(source_clip_id)
        if (
            item.get("sourceType") == "video"
            and source_input_index is not None
            and metadata[source_input_index].get("has_audio")
        ):
            reusable_audio_indexes[audio_index] = source_input_index
        else:
            extra_audio_input_count += 1

    output_width = even(int(number(config.get("width"), 1920)))
    output_height = even(int(number(config.get("height"), 1080)))
    largest_pixels = max(
        output_width * output_height,
        *(max(1, int(info.get("width", 0))) * max(1, int(info.get("height", 0))) for info in metadata),
    )
    decoder_threads, filter_threads = merge_thread_limits(
        len(inputs) + extra_audio_input_count,
        pixel_count=largest_pixels,
    )
    input_queue_size, filter_buffered_frames = merge_memory_limits(largest_pixels)
    input_args = [
        ffmpeg, "-hide_banner", "-loglevel", "warning", "-y",
        "-filter_threads", str(filter_threads),
        "-filter_complex_threads", str(filter_threads),
        "-filter_buffered_frames", str(filter_buffered_frames),
    ]
    for item in inputs:
        input_args.extend([
            "-thread_queue_size", str(input_queue_size),
            "-threads", str(decoder_threads),
            "-i", str(Path(str(item["path"]))),
        ])
    audio_metadata = []
    audio_metadata_cache: dict[str, dict] = {}
    next_audio_input_index = len(inputs)
    for audio_index, item in enumerate(audio_tracks):
        if bool(item.get("muted", False)):
            item["_inputIndex"] = -1
            audio_metadata.append({"duration": 0.01})
            continue
        reused_input_index = reusable_audio_indexes.get(audio_index)
        if reused_input_index is not None:
            item["_inputIndex"] = reused_input_index
            audio_metadata.append({"duration": metadata[reused_input_index]["duration"]})
            continue
        path = Path(str(item.get("path", "")))
        if not path.is_file():
            raise RuntimeError(f"音频文件不存在: {path}")
        item["_inputIndex"] = next_audio_input_index
        next_audio_input_index += 1
        input_args.extend([
            "-thread_queue_size", str(input_queue_size),
            "-threads", str(decoder_threads),
            "-i", str(path),
        ])
        cache_key = os.path.normcase(str(path.resolve()))
        info = audio_metadata_cache.get(cache_key)
        if info is None:
            video_info = video_metadata_cache.get(cache_key)
            info = {"duration": video_info["duration"]} if video_info and video_info["has_audio"] else probe_audio(ffmpeg, path)
            audio_metadata_cache[cache_key] = info
        audio_metadata.append(info)

    emit_progress(8.5, "视频信息读取完成，正在准备时间线")
    filters, total_duration, output_has_audio = build_timeline_filter_graph(
        inputs,
        metadata,
        audio_tracks,
        audio_metadata,
        config,
    )
    emit_progress(
        9.2,
        f"滤镜图准备完成（{output_width}×{output_height}，已限制并行帧缓存）",
    )

    encoding_args = video_encoding_args(config)
    # Encoder frame queues also scale with thread count; keep them aligned with
    # the bounded filter pool instead of letting every codec use all cores.
    encoding_args.extend(["-threads", str(filter_threads)])
    if output_has_audio:
        encoding_args.extend(audio_encoding_args(config))
    encoding_args.extend(["-map_metadata", "-1", "-progress", "pipe:1", "-nostats"])

    if split_mode in {"duration", "count"}:
        split_value = max(1.0, number(config.get("splitValue"), 600))
        segment_time = total_duration / split_value if split_mode == "count" else split_value
        segment_time = max(1.0, segment_time)
        output_stem = unique_output_stem(output_dir, output_stem)
        output_pattern = output_dir / f"{output_stem}_%03d.mp4"
        first_pass_output_args = [
            "-force_key_frames", f"expr:gte(t,n_forced*{segment_time:.6f})",
        ]
        output_args = [
            "-force_key_frames", f"expr:gte(t,n_forced*{segment_time:.6f})",
            "-f", "segment",
            "-segment_time", f"{segment_time:.6f}",
            "-reset_timestamps", "1",
            str(output_pattern),
        ]
        expected_pattern = f"{output_stem}_*.mp4"
    else:
        output_path = unique_output_path(output_dir, output_stem)
        first_pass_output_args = []
        output_args = ["-movflags", "+faststart", str(output_path)]
        expected_pattern = output_path.name

    use_two_pass = (
        str(config.get("rateControl", "quality")).lower() == "bitrate"
        and bool(config.get("twoPass", False))
    )
    # Keep the potentially huge graph out of Windows' command-line limit and
    # ensure every temporary artifact is removed after either pass completes.
    with tempfile.TemporaryDirectory(prefix="video_merge_graph_") as graph_dir:
        graph_path = Path(graph_dir) / "timeline.ffscript"
        write_filter_graph(graph_path, filters)
        # FFmpeg 8 deprecates the legacy filter-graph script flag in favour of
        # the slash-prefixed file argument.  It keeps the graph out of the
        # command line while avoiding a deprecation warning on every export.
        render_args = ["-/filter_complex", str(graph_path), "-map", "[vout]"]
        if output_has_audio:
            render_args.extend(["-map", "[aout]"])
        if use_two_pass:
            with tempfile.TemporaryDirectory(prefix="video_merge_pass_") as pass_dir:
                passlog = str(Path(pass_dir) / "ffmpeg2pass")
                first_pass_filters = list(filters)
                if output_has_audio:
                    first_pass_filters.append("[aout]anullsink")
                first_graph_path = Path(pass_dir) / "first-pass.ffscript"
                write_filter_graph(first_graph_path, first_pass_filters)
                first_pass_args = [
                    "-/filter_complex", str(first_graph_path),
                    "-map", "[vout]",
                    *video_encoding_args(config),
                    "-threads", str(filter_threads),
                    "-pass", "1",
                    "-passlogfile", passlog,
                    "-an",
                    "-map_metadata", "-1",
                    "-progress", "pipe:1",
                    "-nostats",
                    *first_pass_output_args,
                    "-f", "null",
                    os.devnull,
                ]
                emit_progress(10.0, "第 1 遍：分析画面复杂度")
                run_ffmpeg_command(
                    [*input_args, *first_pass_args], total_duration, 10.0, 43.0, "第 1 遍分析",
                )
                emit_progress(54.0, "第 2 遍：按目标码率编码")
                second_pass_args = [
                    *render_args, *encoding_args, "-pass", "2", "-passlogfile", passlog, *output_args,
                ]
                run_ffmpeg_command(
                    [*input_args, *second_pass_args], total_duration, 54.0, 44.0, "第 2 遍编码",
                )
        else:
            emit_progress(10.0, f"开始合并 {len(inputs)} 个视频")
            run_ffmpeg_command(
                [*input_args, *render_args, *encoding_args, *output_args], total_duration, 10.0, 88.0, "正在合并",
            )
    emit_progress(99.0, "正在整理输出文件")

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
