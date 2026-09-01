#!/usr/bin/env python3
"""Merge, resize, crop, trim, and split videos with FFmpeg."""

from __future__ import annotations

import argparse
import ctypes
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
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
MIB = 1024 * 1024
# Independently seeked section inputs are a useful optimisation for ordinary
# multi-track edits, but opening one FFmpeg input per active section scales
# quadratically with overlapping clips.  Keep a conservative budget so large
# projects fall back to the local-section graph backed by one input per clip.
MAX_DYNAMIC_SECTION_INPUTS = 128
MAX_DYNAMIC_INPUT_ARGUMENT_CHARS = 24_000
MAX_HIGH_RES_ACTIVE_LAYERS = 8
# Browser media metadata often reports the coded video duration while FFmpeg's
# text probe reports the container duration (which can include a short audio
# tail).  Clip starts coming from the browser can therefore overlap the next
# FFmpeg clip by a couple of frames.  Only absorb a bounded, frame-relative
# boundary; larger overlaps remain an intentional composition.
MAX_TIMELINE_BOUNDARY_SNAP_FRAMES = 3.0
MAX_TIMELINE_BOUNDARY_SNAP_SECONDS = 0.1
# A positive gap is more likely to be intentional, so only absorb a one-frame
# hole.  This still fixes timestamp quantisation without erasing visible gaps.
MAX_TIMELINE_GAP_SNAP_FRAMES = 1.0

# Hardware encoder discovery is intentionally kept in this process rather than
# probing on every export.  A real one-frame encode is more reliable than
# parsing ``ffmpeg -encoders``: the latter only says that a codec was compiled
# in, not that the driver/device is usable on this machine.
GPU_ENCODER_PROBE_TIMEOUT_SECONDS = 8.0
GPU_ENCODER_PROBE_CACHE: dict[tuple[str, str], bool] = {}
GPU_ENCODER_SELECTION_CACHE: dict[tuple[str, str, str], str | None] = {}
FILTER_BUFFERED_FRAMES_CACHE: dict[str, bool] = {}
GPU_ENCODER_NAMES = {
    "h264_nvenc", "hevc_nvenc",
    "h264_qsv", "hevc_qsv",
    "h264_amf", "hevc_amf",
    "h264_videotoolbox", "hevc_videotoolbox",
}


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


def merge_encoder_threads(pixel_count: int, *, available_cores: int | None = None) -> int:
    """Choose an encoder pool independently from the filter worker count.

    Filter workers are deliberately conservative for high-resolution graphs,
    but tying ``-threads`` for libx264/libx265 to that value made common
    multi-input exports run the encoder on one thread as well.  Keep the
    encoder bounded for UI responsiveness without serialising it unnecessarily.
    """
    cores = max(1, int(available_cores or os.cpu_count() or 1))
    pipeline_cores = max(1, cores - 2)
    encoder_threads = max(1, min(4, pipeline_cores))
    pixels = max(1, int(pixel_count))
    if pixels >= 7680 * 4320:
        return min(encoder_threads, 2)
    if pixels >= 3840 * 2160:
        return min(encoder_threads, 3)
    return encoder_threads


def merge_memory_limits(
    pixel_count: int,
    *,
    input_count: int = 1,
    available_memory: int | None = None,
) -> tuple[int, int]:
    """Return a bounded input queue and a recommended filter-frame budget.

    FFmpeg otherwise allows several demux packets and filter frames to be in
    flight per input.  With seven 4K inputs that multiplies into a very large
    resident set.  Small queues intentionally trade a little throughput for a
    predictable memory ceiling; the filter graph can still make progress as
    frames are consumed.
    """
    return _merge_memory_limits(
        pixel_count,
        input_count=input_count,
        available_memory=available_memory,
    )


def available_memory_bytes() -> int | None:
    """Return physical memory currently available to the process.

    Keep this dependency-free because the standalone FFmpeg environment is
    intentionally small.  psutil is used when available, with native fallbacks
    for Windows and POSIX hosts.
    """
    try:
        import psutil

        available = int(psutil.virtual_memory().available)
        return available if available > 0 else None
    except Exception:
        pass

    if os.name == "nt":
        class MemoryStatusEx(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        try:
            status = MemoryStatusEx()
            status.dwLength = ctypes.sizeof(MemoryStatusEx)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return int(status.ullAvailPhys) or None
        except Exception:
            return None
    else:
        try:
            pages = int(os.sysconf("SC_AVPHYS_PAGES"))
            page_size = int(os.sysconf("SC_PAGE_SIZE"))
            available = pages * page_size
            return available if available > 0 else None
        except (OSError, ValueError, AttributeError):
            pass
    return None


def _merge_memory_limits(
    pixel_count: int,
    *,
    input_count: int = 1,
    available_memory: int | None = None,
) -> tuple[int, int]:
    """Bound packet/frame queues from estimated frame size and host RAM.

    A YUV420 frame is approximately 1.5 bytes per pixel.  The previous fixed
    16-frame UHD/8K queue could therefore reserve roughly 1.6 GiB at 8K and
    over 6 GiB at the UI's 16K maximum before decoder and encoder buffers.  The
    adaptive budget keeps the graph's frame cache below a small fraction of
    available RAM while retaining a little look-ahead for concat/overlay.
    """
    pixels = max(1, int(pixel_count))
    frame_bytes = max(1, int(pixels * 1.5))
    available = available_memory if available_memory and available_memory > 0 else available_memory_bytes()
    # Do not allow the queue policy to consume more than 512 MiB, or more than
    # 8% of currently available physical memory when that is smaller.
    frame_budget = 256 * MIB if available is None else max(64 * MIB, min(512 * MIB, available // 12))
    desired_frames = max(1, min(16, frame_budget // frame_bytes))
    if pixels >= 7680 * 4320:
        # FFmpeg's global frame cap is a graph-wide scheduling limit.  Zero
        # means unlimited, which defeats the memory guard at 8K/16K.  Keep at
        # least one frame so concat/overlay can make progress, while never
        # reserving more than four full-resolution frames for these graphs.
        filter_buffered_frames = max(1, min(4, desired_frames))
    elif pixels >= 3840 * 2160:
        # Keep enough look-ahead for the UHD concat/overlay graph when memory
        # allows it, but never use the old unconditional 16-frame allocation.
        filter_buffered_frames = max(1, min(16, desired_frames))
    else:
        filter_buffered_frames = desired_frames

    if pixels >= 7680 * 4320:
        base_queue = 2
    elif pixels >= 3840 * 2160:
        base_queue = 4
    elif pixels >= 2560 * 1440:
        base_queue = 6
    elif pixels >= 1920 * 1080:
        base_queue = 8
    else:
        base_queue = 12
    # Input packet queues are smaller than frame queues, but scale them down
    # when many decoders compete for the same memory budget.
    queue_pressure = max(1, min(max(1, int(input_count)), 8))
    packet_budget = max(2, frame_budget // max(frame_bytes * queue_pressure, 1))
    input_queue_size = max(2, min(base_queue, packet_budget))
    return input_queue_size, int(filter_buffered_frames)


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
    fps_match = re.search(r"(\d+(?:\.\d+)?)\s+fps\b", text, flags=re.IGNORECASE)
    source_fps = float(fps_match.group(1)) if fps_match else 0.0
    return {
        "duration": max(0.01, duration),
        "width": int(video_match.group(1)),
        "height": int(video_match.group(2)),
        "fps": max(0.0, source_fps),
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


SUPPORTED_OUTPUT_FORMATS = {"mp4", "mkv", "mov"}


def normalize_output_format(value: str | None) -> str:
    """Return the small set of containers supported by the merge pipeline."""
    normalized = str(value or "mp4").strip().lower().lstrip(".")
    if normalized not in SUPPORTED_OUTPUT_FORMATS:
        raise RuntimeError(
            f"不支持的输出格式：{normalized or '空'}，当前仅支持 mp4、mkv、mov。"
        )
    return normalized


def output_suffix(config: dict) -> str:
    return f".{normalize_output_format(config.get('outputFormat'))}"


def unix_seconds_timestamp() -> str:
    """Return the required ten-digit, second-resolution collision suffix."""
    return f"{int(time.time()):010d}"[-10:]


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


def ass_timestamp(seconds: float) -> str:
    """Format seconds as the centisecond timestamps required by ASS."""
    total_centiseconds = max(0, int(round(number(seconds) * 100)))
    hours, remainder = divmod(total_centiseconds, 360000)
    minutes, remainder = divmod(remainder, 6000)
    whole_seconds, centiseconds = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{whole_seconds:02d}.{centiseconds:02d}"


def escape_ass_text(value: str) -> str:
    """Escape user text while preserving intentional line breaks in ASS."""
    return (
        str(value)
        .replace("\\", r"\\")
        .replace("{", r"\{")
        .replace("}", r"\}")
        .replace("\r\n", r"\N")
        .replace("\n", r"\N")
        .replace("\r", r"\N")
    )


def ass_rgb(value: str, fallback: tuple[int, int, int, float]) -> tuple[int, int, int, float]:
    """Parse the CSS colors emitted by the editor into RGB plus opacity."""
    text = str(value or "").strip().lower()
    named = {
        "black": (0, 0, 0, 1.0),
        "blue": (0, 0, 255, 1.0),
        "green": (0, 128, 0, 1.0),
        "red": (255, 0, 0, 1.0),
        "transparent": (0, 0, 0, 0.0),
        "white": (255, 255, 255, 1.0),
        "yellow": (255, 255, 0, 1.0),
    }
    if text in named:
        return named[text]
    if re.fullmatch(r"#[0-9a-f]{6}", text):
        return int(text[1:3], 16), int(text[3:5], 16), int(text[5:7], 16), 1.0
    rgba = re.fullmatch(
        r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)",
        text,
    )
    if rgba:
        red, green, blue, alpha = rgba.groups()
        return (
            max(0, min(255, int(red))),
            max(0, min(255, int(green))),
            max(0, min(255, int(blue))),
            max(0.0, min(1.0, float(alpha) if alpha is not None else 1.0)),
        )
    return fallback


def ass_color(value: str, fallback: tuple[int, int, int, float]) -> str:
    red, green, blue, opacity = ass_rgb(value, fallback)
    alpha = max(0, min(255, int(round((1.0 - opacity) * 255))))
    # ASS stores colours as alpha-blue-green-red.
    return f"&H{alpha:02X}{blue:02X}{green:02X}{red:02X}"


def write_ass_subtitles(
    path: Path,
    text_tracks: list[dict],
    width: int,
    height: int,
    total_duration: float,
) -> None:
    """Write all editor text items as one efficient libass event stream."""
    styles: list[str] = []
    events: list[str] = []
    for index, item in enumerate(text_tracks):
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        start = max(0.0, number(item.get("startTime")))
        duration = max(0.05, number(item.get("duration"), 3.0))
        end = min(total_duration, start + duration)
        if end <= start:
            continue
        style_name = f"MergeText{index}"
        font_size = max(8, min(240, int(number(item.get("fontSize"), 48))))
        primary = ass_color(str(item.get("color", "")), (255, 255, 255, 1.0))
        background = ass_color(str(item.get("backgroundColor", "")), (0, 0, 0, 0.45))
        styles.append(
            f"Style: {style_name},Arial,{font_size},{primary},{primary},&H00000000,{background},"
            "0,0,0,0,100,100,0,0,3,12,0,5,0,0,0,1"
        )
        x_ratio = max(0.0, min(1.0, number(item.get("x"), 0.5)))
        y_ratio = max(0.0, min(1.0, number(item.get("y"), 0.82)))
        x = max(0, min(width, int(round(width * x_ratio))))
        y = max(0, min(height, int(round(height * y_ratio))))
        events.append(
            f"Dialogue: 0,{ass_timestamp(start)},{ass_timestamp(end)},{style_name},"
            f",0,0,0,,{{\\an5\\pos({x},{y})}}{escape_ass_text(text)}"
        )
    path.write_text(
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "PlayResX: {width}\n"
        "PlayResY: {height}\n"
        "ScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,"
        "Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,"
        "Alignment,MarginL,MarginR,MarginV,Encoding\n"
        "{styles}\n\n"
        "[Events]\n"
        "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n"
        "{events}\n".format(width=width, height=height, styles="\n".join(styles), events="\n".join(events)),
        encoding="utf-8-sig",
    )


def ffmpeg_supports_filter(ffmpeg: str, filter_name: str) -> bool:
    """Check optional FFmpeg filters once, without relying on fontconfig."""
    try:
        process = subprocess.run(
            [ffmpeg, "-hide_banner", "-filters"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=ffmpeg_creation_flags(),
            startupinfo=ffmpeg_startup_info(),
            check=False,
        )
    except OSError:
        return False
    return bool(re.search(rf"(?m)^\s*[TSC\.]+\s+{re.escape(filter_name)}\s", process.stdout or ""))


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
    timestamp = unix_seconds_timestamp()
    candidate = output_dir / f"{stem}_{timestamp}{suffix}"
    if not candidate.exists():
        return candidate
    # Two exports can legitimately finish in one second.  Keep the required
    # timestamp in the generated name and add a tiny disambiguator only after
    # it; the destination is still created with no-overwrite semantics by the
    # native finalizer.
    sequence = 1
    while True:
        candidate = output_dir / f"{stem}_{timestamp}_{sequence}{suffix}"
        if not candidate.exists():
            return candidate
        sequence += 1


def unique_output_stem(output_dir: Path, stem: str, suffix: str = ".mp4") -> str:
    if not (output_dir / f"{stem}{suffix}").exists() and not any(
        output_dir.glob(f"{stem}_*{suffix}")
    ):
        return stem
    timestamp = unix_seconds_timestamp()
    candidate = f"{stem}_{timestamp}"
    sequence = 1
    while (output_dir / f"{candidate}{suffix}").exists() or any(
        output_dir.glob(f"{candidate}_*{suffix}")
    ):
        candidate = f"{stem}_{timestamp}_{sequence}"
        sequence += 1
    return candidate


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
    fps = max(1, min(120, int(number(config.get("fps"), 30))))
    source_fps = number(metadata.get("fps"), 0.0)
    downsample_before_scale = source_fps > fps + 0.01
    if downsample_before_scale:
        filters.append(f"fps={fps}")
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

    if not downsample_before_scale:
        filters.append(f"fps={fps}")
    filters.extend(["setsar=1", "format=yuv420p"])
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


def timeline_boundary_tolerances(fps: float | None) -> tuple[float, float]:
    """Return conservative overlap/gap snap tolerances for an output rate.

    The frontend positions clips using browser media durations, while FFmpeg
    may see a tiny container tail.  Use frame-relative tolerances so the
    correction follows the selected output rate, with a hard upper bound that
    cannot silently turn a real edit into a cut.  Positive gaps get a stricter
    one-frame allowance because a visible hole is more likely intentional.
    """
    frame_rate = number(fps, 0.0)
    if not math.isfinite(frame_rate) or frame_rate <= 0.0:
        return 0.0, 0.0
    frame_duration = 1.0 / frame_rate
    overlap_tolerance = min(
        MAX_TIMELINE_BOUNDARY_SNAP_SECONDS,
        MAX_TIMELINE_BOUNDARY_SNAP_FRAMES * frame_duration,
    )
    gap_tolerance = min(
        MAX_TIMELINE_BOUNDARY_SNAP_SECONDS,
        MAX_TIMELINE_GAP_SNAP_FRAMES * frame_duration,
    )
    return overlap_tolerance, gap_tolerance


def normalize_adjacent_timeline_boundaries(
    prepared: list[dict],
    fps: float | None,
) -> None:
    """Snap only near-contiguous clips on the same track to the prior end.

    ``prepared`` is intentionally mutated after source durations and raw
    timeline positions have been resolved.  Sorting a per-track view makes
    the operation independent of the input array order, while leaving
    cross-track overlaps and all larger gaps untouched.
    """
    overlap_tolerance, gap_tolerance = timeline_boundary_tolerances(fps)
    if overlap_tolerance <= 0.0:
        return

    by_track: dict[int, list[dict]] = {}
    for clip in prepared:
        by_track.setdefault(clip["track_index"], []).append(clip)

    for clips in by_track.values():
        clips.sort(key=lambda clip: (clip["timeline_start"], clip["input_index"]))
        previous = None
        for clip in clips:
            if previous is not None:
                delta = clip["timeline_start"] - previous["timeline_end"]
                if -overlap_tolerance <= delta < 0.0:
                    # A small negative delta is normally the container tail of
                    # the preceding clip.  Move the shared boundary backwards
                    # by trimming that tail, rather than moving every later
                    # clip forward and accumulating drift across a long list.
                    adjusted_duration = clip["timeline_start"] - previous["timeline_start"]
                    if adjusted_duration >= 0.01:
                        previous["duration"] = adjusted_duration
                        previous["timeline_end"] = clip["timeline_start"]
                        previous["source_end"] = previous["source_start"] + adjusted_duration
                elif 0.0 < delta <= gap_tolerance:
                    # A one-frame positive hole is timestamp quantisation; the
                    # later clip may safely snap backwards to the prior end.
                    clip["timeline_start"] = previous["timeline_end"]
                    clip["timeline_end"] = clip["timeline_start"] + clip["duration"]
            if previous is None or clip["timeline_end"] > previous["timeline_end"]:
                previous = clip


def prepare_video_items(
    inputs: list[dict],
    metadata: list[dict],
    *,
    fps: float | None = None,
) -> list[dict]:
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
    if fps is not None:
        normalize_adjacent_timeline_boundaries(prepared, fps)
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


def timeline_segments(prepared: list[dict], total_duration: float) -> list[dict]:
    """Return contiguous timeline sections, including intentional blank gaps."""
    boundaries = sorted({
        round(value, 6)
        for clip in prepared
        for value in (clip["timeline_start"], clip["timeline_end"])
    } | {0.0, round(max(0.0, total_duration), 6)})
    segments: list[dict] = []
    for start, end in zip(boundaries, boundaries[1:]):
        if end - start <= 0.000001:
            continue
        midpoint = (start + end) / 2.0
        active = [
            clip for clip in prepared
            if clip["timeline_start"] <= midpoint < clip["timeline_end"]
        ]
        active.sort(key=lambda clip: (clip["track_index"], clip["input_index"]))
        segments.append({"start": start, "end": end, "active": active})
    return segments


def timeline_composition_mode(prepared: list[dict]) -> str:
    """Select the cheapest compositor that preserves the timeline semantics."""
    intervals = timeline_intervals(prepared)
    ordered_prepared = sorted(prepared, key=lambda clip: (clip["timeline_start"], clip["input_index"]))
    cursor = 0.0
    linear_non_overlapping = True
    for clip in ordered_prepared:
        if clip["timeline_start"] < cursor - 0.0005:
            linear_non_overlapping = False
            break
        cursor = max(cursor, clip["timeline_end"])
    if linear_non_overlapping:
        return "linear"
    static_custom_composition = (
        len(prepared) > 1
        and all(bool(clip["item"].get("layoutCustom")) for clip in prepared)
        and bool(intervals)
        and all(len(interval["active"]) > 1 for interval in intervals)
    )
    return "static" if static_custom_composition else "dynamic"


def dynamic_video_section_specs(
    inputs: list[dict],
    metadata: list[dict],
    *,
    force_local_sections: bool = False,
    fps: float | None = None,
) -> list[dict]:
    """Describe one independently seekable input for every dynamic section.

    A split input has to buffer future branches until concat requests them.  For
    a long/high-resolution timeline that can exceed the global filter-frame
    budget.  Re-opening just the active source range per section lets FFmpeg
    release decoded frames as soon as the section is concatenated.
    """
    prepared = prepare_video_items(inputs, metadata, fps=fps)
    composition_mode = timeline_composition_mode(prepared)
    # A linear timeline already consumes each original input exactly once.
    # Re-opening a local section here would add duplicate FFmpeg inputs that
    # the linear graph does not reference (and needlessly probe/decode).
    if composition_mode == "linear":
        return []
    if composition_mode != "dynamic" and not force_local_sections:
        return []
    video_duration = max(clip["timeline_end"] for clip in prepared)
    specs: list[dict] = []
    for section_index, section in enumerate(timeline_segments(prepared, video_duration)):
        section_duration = section["end"] - section["start"]
        for clip in section["active"]:
            specs.append({
                "section_index": section_index,
                "input_index": clip["input_index"],
                "path": str(clip["item"]["path"]),
                "source_start": clip["source_start"] + section["start"] - clip["timeline_start"],
                "duration": section_duration,
            })
    # Keep the optimisation bounded.  When this budget is exceeded the caller
    # deliberately passes no section map to the compositor, which uses one
    # original input per clip and still composes each local interval before
    # concat.  That preserves timeline semantics without opening O(N²) input
    # decoders or exceeding Windows' CreateProcess command-line limit.
    estimated_argument_chars = sum(
        len(str(spec["path"])) + 96
        for spec in specs
    )
    if (
        len(specs) > MAX_DYNAMIC_SECTION_INPUTS
        or estimated_argument_chars > MAX_DYNAMIC_INPUT_ARGUMENT_CHARS
    ):
        return []
    return specs


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


def prepare_subtitle_font_dir(font_file: str | None, directory: Path) -> Path | None:
    """Make a private libass font directory containing only the chosen font.

    Passing the platform's complete Fonts directory to libass makes it scan
    hundreds of legacy bitmap fonts on Windows and can flood stderr.  A hard
    link avoids duplicating a large font when possible; copy2 is the portable
    fallback for filesystems that do not support links.
    """
    if not font_file:
        return None
    source = Path(font_file).expanduser()
    if not source.is_file():
        return None
    try:
        directory.mkdir(parents=True, exist_ok=True)
        destination = directory / source.name
        if not destination.exists():
            try:
                os.link(source, destination)
            except (OSError, NotImplementedError):
                shutil.copy2(source, destination)
        return directory
    except OSError:
        return None


def build_timeline_filter_graph(
    inputs: list[dict],
    metadata: list[dict],
    audio_tracks: list[dict],
    audio_metadata: list[dict],
    config: dict,
    *,
    subtitle_path: Path | None = None,
    subtitle_font_dir: Path | None = None,
    section_input_indices: dict[tuple[int, int], int] | None = None,
    force_local_sections: bool = False,
) -> tuple[list[str], float, bool]:
    fps = max(1, min(120, int(number(config.get("fps"), 30))))
    prepared = prepare_video_items(inputs, metadata, fps=fps)
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
    background = "white" if config.get("canvasBackground") == "white" else "black"
    filters: list[str] = []
    drawtext_font_file = resolve_drawtext_font_file()

    # A non-overlapping edit can be represented as clips plus cheap color gap
    # sources.  Dynamic compositions are rendered as local sections and then
    # concatenated so overlays do not process inactive portions of the timeline.
    composition_mode = timeline_composition_mode(prepared)
    ordered_prepared = sorted(prepared, key=lambda clip: (clip["timeline_start"], clip["input_index"]))
    # A multi-camera composition with custom cells that are present throughout
    # the timeline has a fixed geometry.  It can be overlaid once per input
    # instead of splitting every source at every interval boundary.
    dynamic_compositor_segments = sum(len(interval["active"]) for interval in intervals)
    dynamic_budget = dynamic_compositor_budget(width, height, metadata)
    if width * height >= 3840 * 2160 and any(
        len(interval["active"]) > MAX_HIGH_RES_ACTIVE_LAYERS for interval in intervals
    ):
        raise RuntimeError(
            f"高分辨率时间线的单个区间最多支持 {MAX_HIGH_RES_ACTIVE_LAYERS} 个同时画面层，"
            "请拆分轨道或降低输出分辨率后再导出。"
        )
    if composition_mode == "dynamic" and dynamic_compositor_segments > dynamic_budget:
        raise RuntimeError(
            "多轨时间线过于复杂，预计需要处理 "
            f"{dynamic_compositor_segments} 个画面区间，已超过安全上限（当前分辨率上限 "
            f"{dynamic_budget}）。请拆分项目导出，或为持续画中画改用固定自定义布局。"
        )
    # Static full-duration overlays retain every UHD frame branch until the
    # final mux.  Force them through the interval-local compositor at 4K/8K
    # so each section can be consumed and released by concat immediately.
    if force_local_sections and composition_mode == "static":
        composition_mode = "dynamic"

    if composition_mode == "linear":
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
            # Boundary normalization may shorten a clip's coded tail.  Pass
            # the resolved source range to the per-input filter so the linear
            # concat duration and the audio delay remain on the same clock.
            filter_item = dict(clip["item"])
            filter_item["trimStart"] = clip["source_start"]
            filter_item["trimEnd"] = clip["source_end"]
            filter_text, _, _, _ = build_video_filter(index, clip["metadata"], filter_item, config)
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
    elif composition_mode == "static":
        cells = layout_cells(prepared, width, height)
        filters.append(f"color=c={background}:s={width}x{height}:r={fps}:d={total_duration:.6f}[canvas0]")
        for overlay_index, (clip, (x, y, cell_width, cell_height)) in enumerate(zip(prepared, cells)):
            chain = [
                f"[{clip['input_index']}:v:0]trim=start={clip['source_start']:.6f}:end={clip['source_end']:.6f}",
                "setpts=PTS-STARTPTS",
            ]
            source_fps = number(clip["metadata"].get("fps"), 0.0)
            downsample_before_scale = source_fps > fps + 0.01
            if downsample_before_scale:
                chain.append(f"fps={fps}")
            append_rotation_and_crop(chain, clip["metadata"], clip["item"])
            append_cell_fit(chain, cell_width, cell_height, config)
            if not downsample_before_scale:
                chain.append(f"fps={fps}")
            chain.extend([
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
        if not section_input_indices:
            for clip in prepared:
                index = clip["input_index"]
                count = branch_counts[index]
                if count <= 1:
                    source_labels[index] = deque([f"[{index}:v:0]"])
                    continue
                labels = [f"vsrc{index}_{branch}" for branch in range(count)]
                filters.append(f"[{index}:v:0]split={count}{''.join(f'[{label}]' for label in labels)}")
                source_labels[index] = deque(f"[{label}]" for label in labels)

        # Compose each contiguous interval on a local canvas and concatenate
        # those finished sections.  The previous implementation overlaid every
        # interval onto one full-duration canvas, forcing each overlay node to
        # process the whole timeline even when its source was active briefly.
        segment_labels: list[str] = []
        timeline_sections = timeline_segments(prepared, total_duration)
        for section_index, section in enumerate(timeline_sections):
            section_duration = section["end"] - section["start"]
            active = section["active"]
            if not active:
                gap_label = f"vgapdynamic{section_index}"
                filters.append(
                    f"color=c={background}:s={width}x{height}:r={fps}:d={section_duration:.6f},"
                    f"setsar=1,format=yuv420p[{gap_label}]"
                )
                segment_labels.append(f"[{gap_label}]")
                continue

            canvas_label = f"dynamiccanvas{section_index}_0"
            filters.append(
                f"color=c={background}:s={width}x{height}:r={fps}:d={section_duration:.6f},"
                f"setsar=1,format=yuv420p[{canvas_label}]"
            )
            current_canvas = canvas_label
            cells = layout_cells(active, width, height)
            for local_index, (clip, (x, y, cell_width, cell_height)) in enumerate(zip(active, cells)):
                source_offset = section["start"] - clip["timeline_start"]
                source_start = clip["source_start"] + source_offset
                source_end = min(clip["source_end"], source_start + section_duration)
                section_source_index = (
                    section_input_indices.get((section_index, clip["input_index"]))
                    if section_input_indices
                    else None
                )
                source_label = (
                    f"[{section_source_index}:v:0]"
                    if section_source_index is not None
                    else source_labels[clip["input_index"]].popleft()
                )
                trim_start = 0.0 if section_source_index is not None else source_start
                trim_end = section_duration if section_source_index is not None else source_end
                chain = [
                    f"{source_label}trim=start={trim_start:.6f}:end={trim_end:.6f}",
                    "setpts=PTS-STARTPTS",
                ]
                source_fps = number(clip["metadata"].get("fps"), 0.0)
                downsample_before_scale = source_fps > fps + 0.01
                if downsample_before_scale:
                    chain.append(f"fps={fps}")
                append_rotation_and_crop(chain, clip["metadata"], clip["item"])
                append_cell_fit(chain, cell_width, cell_height, config)
                if not downsample_before_scale:
                    chain.append(f"fps={fps}")
                chain.extend(["setsar=1", "format=yuv420p"])
                video_label = f"dynamicvideo{section_index}_{local_index}"
                filters.append(",".join(chain) + f"[{video_label}]")
                next_canvas = f"dynamiccanvas{section_index}_{local_index + 1}"
                filters.append(
                    f"[{current_canvas}][dynamicvideo{section_index}_{local_index}]"
                    f"overlay=x={x}:y={y}:eof_action=pass:repeatlast=0:shortest=0[{next_canvas}]"
                )
                current_canvas = next_canvas
            section_label = f"vsection{section_index}"
            filters.append(
                f"[{current_canvas}]trim=duration={section_duration:.6f},setpts=PTS-STARTPTS,"
                f"format=yuv420p[{section_label}]"
            )
            segment_labels.append(f"[{section_label}]")

        if not segment_labels:
            raise RuntimeError("时间线没有可合成的画面区间。")
        if len(segment_labels) == 1:
            filters.append(f"{segment_labels[0]}null[vbase]")
        else:
            filters.append(
                f"{''.join(segment_labels)}concat=n={len(segment_labels)}:v=1:a=0[vbase]"
            )
        text_input_label = "vbase"
    text_items = [item for item in text_tracks if str(item.get("text", "")).strip()]
    if text_items and subtitle_path is not None:
        write_ass_subtitles(subtitle_path, text_items, width, height, total_duration)
        font_dir = subtitle_font_dir
        subtitle_options = f"fontsdir='{escape_drawtext(str(font_dir))}'" if font_dir else ""
        next_label = "textcanvas-ass"
        filters.append(
            f"[{text_input_label}]subtitles='{escape_drawtext(str(subtitle_path))}'"
            f"{':' + subtitle_options if subtitle_options else ''}[{next_label}]"
        )
        text_input_label = next_label
    else:
        if text_items and not drawtext_font_file:
            raise RuntimeError("当前 FFmpeg 不支持 ASS 字幕，且未找到可用字体文件，无法安全渲染文本。")
        for text_index, item in enumerate(text_items):
            text = str(item.get("text", "")).strip()
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


def requested_video_codec(config: dict) -> str:
    """Return the requested codec family in the names used by FFmpeg."""
    return "h265" if str(config.get("videoEncoder", "h264")).lower() in {"h265", "hevc"} else "h264"


def force_cpu_encoding() -> bool:
    """Allow support and bug reports to disable hardware probing explicitly."""
    values = (
        os.environ.get("VIDEO_SIM_FORCE_CPU", ""),
        os.environ.get("VIDEO_SIM_DISABLE_GPU", ""),
    )
    return any(value.strip().lower() in {"1", "true", "yes", "on"} for value in values)


def hardware_encoder_candidates(codec: str, platform: str | None = None) -> list[str]:
    """Return safe software-frame hardware candidates for one codec family.

    VAAPI is deliberately not included: it requires a device path and an
    explicit ``hwupload`` branch, which would make an otherwise portable
    timeline fail on headless Linux.  NVENC and QSV can consume software
    frames directly, and are therefore safe candidates for this filter graph.
    """
    normalized_codec = "h265" if str(codec).lower() in {"h265", "hevc"} else "h264"
    target = str(platform or sys.platform).lower()
    if target.startswith("win") or target in {"nt", "windows"}:
        suffixes = ("nvenc", "qsv", "amf")
    elif target.startswith("darwin") or target in {"mac", "macos", "osx"}:
        suffixes = ("videotoolbox",)
    elif target.startswith("linux") or target.startswith("freebsd"):
        suffixes = ("nvenc", "qsv")
    else:
        suffixes = ()
    prefix = "hevc" if normalized_codec == "h265" else "h264"
    return [f"{prefix}_{suffix}" for suffix in suffixes]


def _resolved_executable_key(ffmpeg: str) -> str:
    try:
        return str(Path(ffmpeg).resolve()).lower()
    except (OSError, RuntimeError):
        return str(ffmpeg).lower()


def probe_hardware_encoder(ffmpeg: str, encoder: str) -> bool:
    """Perform and cache a tiny real encode to verify a device/driver pair."""
    if encoder not in GPU_ENCODER_NAMES:
        return False
    key = (_resolved_executable_key(ffmpeg), encoder)
    cached = GPU_ENCODER_PROBE_CACHE.get(key)
    if cached is not None:
        return cached
    command = [
        ffmpeg,
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=32x32:r=1:d=0.1",
        "-frames:v", "1", "-an",
        "-c:v", encoder, "-pix_fmt", "yuv420p",
        "-f", "null", os.devnull,
    ]
    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=GPU_ENCODER_PROBE_TIMEOUT_SECONDS,
            creationflags=ffmpeg_creation_flags(),
            startupinfo=ffmpeg_startup_info(),
        )
        available = completed.returncode == 0
    except (OSError, subprocess.SubprocessError):
        available = False
    GPU_ENCODER_PROBE_CACHE[key] = available
    return available


def probe_filter_buffered_frames(ffmpeg: str) -> bool:
    """Check whether this FFmpeg build safely caps a concat/amix graph.

    Some FFmpeg 8 builds accept the option but return ENOMEM while wiring a
    graph containing trim/scale/amix.  A plain ``-filters`` capability check
    misses that regression, so this probe executes a tiny representative graph
    and caches the result per executable.
    """
    key = _resolved_executable_key(ffmpeg)
    cached = FILTER_BUFFERED_FRAMES_CACHE.get(key)
    if cached is not None:
        return cached
    graph = (
        "[0:v]trim=start=0:end=0.5,setpts=PTS-STARTPTS,scale=32:32,"
        "format=yuv420p[vout];"
        "[1:a]atrim=start=0:end=0.5,asetpts=PTS-STARTPTS,aresample=48000,"
        "aformat=sample_fmts=fltp:channel_layouts=stereo,"
        "amix=inputs=1:duration=longest,atrim=duration=0.5,"
        "asetpts=PTS-STARTPTS[aout]"
    )
    command = [
        ffmpeg,
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-filter_threads", "1", "-filter_complex_threads", "1",
        "-filter_buffered_frames", "1",
        "-f", "lavfi", "-i", "color=c=black:s=32x32:r=10:d=1",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
        "-filter_complex", graph,
        "-map", "[vout]", "-map", "[aout]", "-t", "0.5",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
        "-f", "null", os.devnull,
    ]
    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=GPU_ENCODER_PROBE_TIMEOUT_SECONDS,
            creationflags=ffmpeg_creation_flags(),
            startupinfo=ffmpeg_startup_info(),
        )
        available = completed.returncode == 0
    except (OSError, subprocess.SubprocessError):
        available = False
    FILTER_BUFFERED_FRAMES_CACHE[key] = available
    return available


def filter_buffered_frames_args(ffmpeg: str, frame_budget: int) -> list[str]:
    """Return a guarded frame-cap option, or no option for unsafe builds."""
    budget = max(0, int(frame_budget))
    if budget <= 0 or not probe_filter_buffered_frames(ffmpeg):
        return []
    return ["-filter_buffered_frames", str(budget)]


def select_video_encoder(ffmpeg: str, config: dict) -> dict[str, object]:
    """Select a usable encoder, preferring hardware without hiding failures."""
    codec = requested_video_codec(config)
    cpu_encoder = "libx265" if codec == "h265" else "libx264"
    if force_cpu_encoding():
        log("已通过 VIDEO_SIM_FORCE_CPU 禁用 GPU 编码，使用 CPU 编码")
        return {"encoder": cpu_encoder, "is_hardware": False, "codec": codec}

    candidates = hardware_encoder_candidates(codec)
    preferred = str(
        config.get("hardwareEncoder")
        or os.environ.get("VIDEO_SIM_GPU_ENCODER", "")
    ).strip().lower()
    if preferred in candidates:
        candidates = [preferred, *[candidate for candidate in candidates if candidate != preferred]]
    cache_key = (_resolved_executable_key(ffmpeg), codec, ",".join(candidates))
    if cache_key in GPU_ENCODER_SELECTION_CACHE:
        selected = GPU_ENCODER_SELECTION_CACHE[cache_key]
    else:
        selected = next((candidate for candidate in candidates if probe_hardware_encoder(ffmpeg, candidate)), None)
        GPU_ENCODER_SELECTION_CACHE[cache_key] = selected
    if selected:
        log(f"仅编码阶段使用 GPU 加速：{selected}（滤镜、解码和输入仍由 FFmpeg CPU 管线处理）")
        return {"encoder": selected, "is_hardware": True, "codec": codec}
    log(f"未检测到可用的 {codec.upper()} 硬件编码器，使用 CPU 编码：{cpu_encoder}")
    return {"encoder": cpu_encoder, "is_hardware": False, "codec": codec}


_CPU_PRESETS = {
    "ultrafast", "superfast", "veryfast", "faster", "fast",
    "medium", "slow", "slower", "veryslow",
}
_NVENC_PRESET_MAP = {
    "ultrafast": "p1", "superfast": "p2", "veryfast": "p3",
    "faster": "p4", "fast": "p4", "medium": "p5", "slow": "p6",
    "slower": "p7", "veryslow": "p7",
}
_QSV_PRESET_MAP = {
    "ultrafast": "veryfast", "superfast": "veryfast", "veryfast": "veryfast",
    "faster": "faster", "fast": "fast", "medium": "medium", "slow": "slow",
    "slower": "slower", "veryslow": "veryslow",
}


def _quality_value(config: dict) -> int:
    return max(0, min(51, int(number(config.get("crf"), 23))))


def _bitrate_value(config: dict) -> int:
    return max(100, min(100000, int(number(config.get("videoBitrate"), 4000))))


def _hardware_encoder_preset(encoder: str, requested: str) -> tuple[str | None, str | None]:
    if encoder.endswith("_nvenc"):
        return "-preset", _NVENC_PRESET_MAP.get(requested, "p5")
    if encoder.endswith("_qsv"):
        return "-preset", _QSV_PRESET_MAP.get(requested, "medium")
    if encoder.endswith("_amf"):
        quality = "speed" if requested in {"ultrafast", "superfast", "veryfast", "faster"} else (
            "quality" if requested in {"slow", "slower", "veryslow"} else "balanced"
        )
        return "-quality", quality
    # VideoToolbox does not expose the x264-style preset names.
    return None, None


def video_encoding_args(config: dict, encoder: str | None = None) -> list[str]:
    codec = requested_video_codec(config)
    encoder = encoder or ("libx265" if codec == "h265" else "libx264")
    preset = str(config.get("encoderPreset", "medium")).lower()
    if preset not in _CPU_PRESETS:
        preset = "medium"
    args = ["-c:v", encoder]
    if encoder in GPU_ENCODER_NAMES:
        preset_flag, preset_value = _hardware_encoder_preset(encoder, preset)
        if preset_flag and preset_value:
            args.extend([preset_flag, preset_value])
        if str(config.get("rateControl", "quality")).lower() == "bitrate":
            args.extend(["-b:v", f"{_bitrate_value(config)}k"])
        elif encoder.endswith("_nvenc"):
            # NVENC's CQ/VBR pair is the hardware equivalent of CRF.
            args.extend(["-rc:v", "vbr", "-cq", str(_quality_value(config)), "-b:v", "0"])
        elif encoder.endswith("_qsv"):
            args.extend(["-global_quality", str(_quality_value(config))])
        elif encoder.endswith("_amf"):
            args.extend(["-qp_i", str(_quality_value(config)), "-qp_p", str(_quality_value(config))])
        else:  # VideoToolbox exposes a global video quantizer, not CRF.
            args.extend(["-q:v", str(_quality_value(config))])
    else:
        args.append("-preset")
        args.append(preset)
        if str(config.get("rateControl", "quality")).lower() == "bitrate":
            args.extend(["-b:v", f"{_bitrate_value(config)}k"])
        else:
            args.extend(["-crf", str(_quality_value(config))])
    # QSV's software-frame path requires NV12 at the encoder boundary.  The
    # other backends accept yuv420p and FFmpeg performs the final conversion.
    output_pixel_format = "nv12" if encoder.endswith("_qsv") else "yuv420p"
    args.extend(["-pix_fmt", output_pixel_format])
    return args


def hardware_two_pass_args(encoder: str, config: dict) -> list[str]:
    """Use codec-native multipass/look-ahead when the UI requests two-pass."""
    if encoder not in GPU_ENCODER_NAMES:
        return []
    if str(config.get("rateControl", "quality")).lower() != "bitrate" or not bool(config.get("twoPass", False)):
        return []
    if encoder.endswith("_nvenc"):
        return ["-multipass", "full"]
    if encoder.endswith("_qsv"):
        return ["-look_ahead", "1"]
    if encoder.endswith("_amf"):
        return ["-vbaq", "1"]
    # VideoToolbox has no portable external two-pass API.  It still receives
    # the requested average bitrate and remains a single hardware pass.
    return []


def is_gpu_encoder_failure(error: BaseException, encoder: str | None = None) -> bool:
    """Classify only explicit encoder/device failures as safe for CPU retry."""
    details = str(getattr(error, "stderr_details", error)).lower()
    if any(marker in details for marker in (
        "error while filtering", "failed to inject frame into filter",
        "error reinitializing filters", "error opening input",
        "no such file or directory", "invalid data found",
    )):
        return False
    selected = str(encoder or "").strip().lower()
    backend_markers = {
        "nvenc": (
            "nvenc", "nvcuda", "cuda_error", "no capable devices found",
            "driver does not support required nvenc", "initializeencoder failed",
        ),
        "qsv": (
            "qsv", "mfx", "onevpl", "intel media sdk", "error initializing an mfx session",
        ),
        "amf": ("amf", "amd media framework", "createcomponent("),
        "videotoolbox": ("videotoolbox", "compression session", "videotoolboxsession"),
    }
    backend = next((name for name in backend_markers if name in selected), None)
    if not selected and not backend:
        return False
    # Require either the exact selected encoder label (for example
    # ``[h264_qsv]``) or a backend-specific driver/device marker.  Generic
    # ``ENOMEM`` and ``Error initializing output stream`` are intentionally not
    # enough: those commonly originate in the filter graph and must surface to
    # the user instead of triggering a misleading second export.
    if selected and selected in details:
        return True
    if backend:
        return any(marker in details for marker in backend_markers[backend])
    return False


class FFmpegCommandError(RuntimeError):
    """Preserve FFmpeg diagnostics so a hardware attempt can be retried safely."""

    def __init__(self, exit_code: int, stderr_details: str):
        self.exit_code = exit_code
        self.stderr_details = stderr_details
        super().__init__(f"FFmpeg 合并失败，退出码 {exit_code}：{stderr_details[-1800:]}")


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
        raise FFmpegCommandError(exit_code, details)


def write_filter_graph(path: Path, filters: list[str]) -> None:
    """Store large filter graphs in a file to avoid platform command limits."""
    path.write_text(";".join(filters), encoding="utf-8")


def cleanup_partial_outputs(output_dir: Path, expected_pattern: str) -> None:
    """Remove only outputs owned by the current unique export stem."""
    for path in output_dir.glob(expected_pattern):
        try:
            if path.is_file():
                path.unlink()
        except OSError as error:
            log(f"清理未完成输出失败（将继续 CPU 重试）：{path}：{error}")


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
    output_format = normalize_output_format(config.get("outputFormat"))
    output_suffix_value = f".{output_format}"
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
    output_fps = max(1, min(120, int(number(config.get("fps"), 30))))
    largest_pixels = max(
        output_width * output_height,
        *(max(1, int(info.get("width", 0))) * max(1, int(info.get("height", 0))) for info in metadata),
    )
    force_local_sections = largest_pixels >= 3840 * 2160
    dynamic_source_specs = dynamic_video_section_specs(
        inputs,
        metadata,
        force_local_sections=force_local_sections,
        fps=output_fps,
    )
    decoder_threads, filter_threads = merge_thread_limits(
        len(inputs) + extra_audio_input_count,
        pixel_count=largest_pixels,
    )
    encoder_threads = merge_encoder_threads(largest_pixels)
    input_queue_size, filter_frame_budget = merge_memory_limits(
        largest_pixels,
        input_count=len(inputs) + extra_audio_input_count + len(dynamic_source_specs),
        available_memory=available_memory_bytes(),
    )
    input_args = [
        ffmpeg, "-hide_banner", "-loglevel", "warning", "-y",
        "-filter_threads", str(filter_threads),
        "-filter_complex_threads", str(filter_threads),
        *filter_buffered_frames_args(ffmpeg, filter_frame_budget),
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

    # Dynamic sections are consumed serially by concat.  Re-opening only the
    # active source range per section avoids split branches accumulating future
    # UHD frames while an earlier section is still being encoded.
    section_input_indices: dict[tuple[int, int], int] = {}
    next_section_input_index = next_audio_input_index
    for spec in dynamic_source_specs:
        section_input_indices[(spec["section_index"], spec["input_index"])] = next_section_input_index
        input_args.extend([
            "-ss", f"{max(0.0, spec['source_start']):.6f}",
            "-t", f"{max(0.01, spec['duration']):.6f}",
            "-thread_queue_size", str(input_queue_size),
            "-threads", str(decoder_threads),
            "-i", str(Path(spec["path"])),
        ])
        next_section_input_index += 1

    use_two_pass = (
        str(config.get("rateControl", "quality")).lower() == "bitrate"
        and bool(config.get("twoPass", False))
    )
    # Keep the potentially huge graph out of Windows' command-line limit and
    # ensure every temporary artifact is removed after either pass completes.
    with tempfile.TemporaryDirectory(prefix="video_merge_graph_") as graph_dir:
        emit_progress(8.5, "视频信息读取完成，正在准备时间线")
        text_items = [item for item in (config.get("textTracks") or []) if str(item.get("text", "")).strip()]
        subtitle_path = None
        subtitle_font_dir = None
        selected_font_file = resolve_drawtext_font_file() if text_items else None
        if text_items and selected_font_file and ffmpeg_supports_filter(ffmpeg, "subtitles"):
            subtitle_font_dir = prepare_subtitle_font_dir(
                selected_font_file,
                Path(graph_dir) / "fonts",
            )
            if subtitle_font_dir is not None:
                subtitle_path = Path(graph_dir) / "timeline.ass"
        filters, total_duration, output_has_audio = build_timeline_filter_graph(
            inputs,
            metadata,
            audio_tracks,
            audio_metadata,
            config,
            subtitle_path=subtitle_path,
            subtitle_font_dir=subtitle_font_dir,
            section_input_indices=section_input_indices or None,
            force_local_sections=force_local_sections,
        )
        emit_progress(
            9.2,
            f"滤镜图准备完成（{output_width}×{output_height}，已限制输入队列和滤镜并行）",
        )

        graph_path = Path(graph_dir) / "timeline.ffscript"
        write_filter_graph(graph_path, filters)
        if split_mode in {"duration", "count"}:
            split_value = max(1.0, number(config.get("splitValue"), 600))
            segment_time = total_duration / split_value if split_mode == "count" else split_value
            segment_time = max(1.0, segment_time)
            output_stem = unique_output_stem(output_dir, output_stem, output_suffix_value)
            output_pattern = output_dir / f"{output_stem}_%03d{output_suffix_value}"
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
            expected_pattern = f"{output_stem}_*{output_suffix_value}"
        else:
            output_path = unique_output_path(output_dir, output_stem, output_suffix_value)
            first_pass_output_args = []
            output_args = []
            if output_format in {"mp4", "mov"}:
                output_args.extend(["-movflags", "+faststart"])
            output_args.append(str(output_path))
            expected_pattern = output_path.name
        # FFmpeg 8 deprecates the legacy filter-graph script flag in favour of
        # the slash-prefixed file argument.  It keeps the graph out of the
        # command line while avoiding a deprecation warning on every export.
        render_args = ["-/filter_complex", str(graph_path), "-map", "[vout]"]
        if output_has_audio:
            render_args.extend(["-map", "[aout]"])

        def build_encoding_args(plan: dict[str, object]) -> list[str]:
            selected_encoder = str(plan["encoder"])
            args = video_encoding_args(config, selected_encoder)
            # Keep the filter pool conservative for memory, but let the codec
            # use a separate bounded pool so high-resolution exports are not
            # serialised.  Hardware codecs may ignore this value safely.
            args.extend(["-threads", str(encoder_threads)])
            if bool(plan["is_hardware"]):
                args.extend(hardware_two_pass_args(selected_encoder, config))
            if output_has_audio:
                args.extend(audio_encoding_args(config))
            args.extend(["-map_metadata", "-1", "-progress", "pipe:1", "-nostats"])
            return args

        def execute_export(plan: dict[str, object]) -> None:
            selected_encoder = str(plan["encoder"])
            is_hardware = bool(plan["is_hardware"])
            encoding_args = build_encoding_args(plan)
            # External -pass 1/-pass 2 is incompatible with most hardware
            # encoders.  Their native multipass/look-ahead option is attached
            # above and the timeline is rendered once through the GPU codec.
            external_two_pass = use_two_pass and not is_hardware
            if use_two_pass and is_hardware:
                if hardware_two_pass_args(selected_encoder, config):
                    log(f"{selected_encoder} 使用硬件原生多遍分析参数（仅编码阶段 GPU 加速）")
                else:
                    log(f"{selected_encoder} 不支持通用外部 two-pass，使用硬件单遍码率控制")
            if external_two_pass:
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
                        *video_encoding_args(config, selected_encoder),
                        "-threads", str(encoder_threads),
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

        encoder_plan = select_video_encoder(ffmpeg, config)
        try:
            execute_export(encoder_plan)
        except FFmpegCommandError as error:
            # Only a hardware initialization/encoder/device error is safe to
            # retry.  Input and filter failures keep their original error so
            # the UI does not report a misleading successful fallback.
            if (
                not bool(encoder_plan["is_hardware"])
                or not is_gpu_encoder_failure(error, str(encoder_plan["encoder"]))
            ):
                raise
            cleanup_partial_outputs(output_dir, expected_pattern)
            codec = str(encoder_plan["codec"])
            failed_encoder = str(encoder_plan["encoder"])
            GPU_ENCODER_PROBE_CACHE[(_resolved_executable_key(ffmpeg), failed_encoder)] = False
            for selection_key in list(GPU_ENCODER_SELECTION_CACHE):
                if selection_key[:2] == (_resolved_executable_key(ffmpeg), codec):
                    GPU_ENCODER_SELECTION_CACHE[selection_key] = None
            cpu_encoder = "libx265" if codec == "h265" else "libx264"
            log(
                f"GPU 编码器 {failed_encoder} 初始化/编码失败，已清理未完成输出；"
                f"正在使用 CPU 编码重试：{cpu_encoder}。原始错误：{error.stderr_details[-900:]}"
            )
            execute_export({"encoder": cpu_encoder, "is_hardware": False, "codec": codec})
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
