from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "merge_videos.py"
SPEC = importlib.util.spec_from_file_location("merge_videos_script", SCRIPT_PATH)
assert SPEC and SPEC.loader
merge_videos = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(merge_videos)


def test_rotation_and_clip_crop_are_applied_before_output_scaling():
    metadata = {
        "duration": 10.0,
        "width": 1920,
        "height": 1080,
        "has_audio": True,
    }
    item = {
        "trimStart": 2.0,
        "trimEnd": 7.0,
        "rotation": 90,
        "cropEnabled": True,
        "cropX": 10,
        "cropY": 20,
        "cropWidth": 800,
        "cropHeight": 1200,
    }
    config = {
        "width": 1280,
        "height": 720,
        "fitMode": "contain",
        "fps": 30,
    }

    filter_text, start, end, duration = merge_videos.build_video_filter(
        0,
        metadata,
        item,
        config,
    )

    assert start == 2.0
    assert end == 7.0
    assert duration == 5.0
    assert "transpose=clock" in filter_text
    assert "crop=800:1200:10:20" in filter_text
    assert filter_text.index("transpose=clock") < filter_text.index("crop=800:1200:10:20")
    assert filter_text.index("crop=800:1200:10:20") < filter_text.index("scale=1280:720")


def test_each_clip_uses_its_own_transform_settings():
    metadata = {
        "duration": 4.0,
        "width": 1280,
        "height": 720,
        "has_audio": False,
    }
    config = {
        "width": 640,
        "height": 360,
        "fitMode": "stretch",
        "fps": 24,
    }

    unmodified, *_ = merge_videos.build_video_filter(0, metadata, {}, config)
    transformed, *_ = merge_videos.build_video_filter(
        1,
        metadata,
        {
            "rotation": 180,
            "cropEnabled": True,
            "cropX": 100,
            "cropY": 50,
            "cropWidth": 600,
            "cropHeight": 400,
        },
        config,
    )

    assert "hflip,vflip" not in unmodified
    assert "crop=" not in unmodified
    assert "hflip,vflip" in transformed
    assert "crop=600:400:100:50" in transformed


def test_contain_mode_uses_selected_canvas_background():
    metadata = {
        "duration": 3.0,
        "width": 640,
        "height": 360,
        "has_audio": False,
    }
    filter_text, *_ = merge_videos.build_video_filter(
        0,
        metadata,
        {},
        {
            "width": 1920,
            "height": 1080,
            "fitMode": "contain",
            "canvasBackground": "white",
            "fps": 30,
        },
    )

    assert "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=white" in filter_text


def test_overlapping_video_tracks_are_tiled_and_audio_is_mixed():
    inputs = [
        {
            "path": "one.mp4",
            "startTime": 0,
            "trackIndex": 0,
            "trimStart": 0,
            "trimEnd": 4,
        },
        {
            "path": "two.mp4",
            "startTime": 0,
            "trackIndex": 1,
            "trimStart": 0,
            "trimEnd": 4,
        },
    ]
    metadata = [
        {"duration": 4.0, "width": 1920, "height": 1080, "has_audio": True},
        {"duration": 4.0, "width": 1080, "height": 1920, "has_audio": True},
    ]
    audio_tracks = [{"startTime": 1, "trimStart": 0, "trimEnd": 2}]
    audio_metadata = [{"duration": 2.0}]

    filters, duration, has_audio = merge_videos.build_timeline_filter_graph(
        inputs,
        metadata,
        audio_tracks,
        audio_metadata,
        {
            "width": 1280,
            "height": 720,
            "fitMode": "contain",
            "canvasBackground": "black",
            "fps": 30,
            "includeAudio": True,
        },
    )
    graph = ";".join(filters)

    assert duration == 4.0
    assert has_audio is True
    assert "overlay=x=0:y=0" in graph
    assert "overlay=x=640:y=0" in graph
    assert "adelay=1000:all=1[externala0]" in graph
    assert "amix=inputs=3:duration=longest:normalize=0" in graph


def test_custom_video_layout_is_used_for_overlay_coordinates():
    inputs = [
        {
            "path": "one.mp4",
            "startTime": 0,
            "trackIndex": 0,
            "layoutCustom": True,
            "layoutX": 0.1,
            "layoutY": 0.2,
            "layoutWidth": 0.4,
            "layoutHeight": 0.5,
        },
        {
            "path": "two.mp4",
            "startTime": 0,
            "trackIndex": 1,
            "layoutCustom": True,
            "layoutX": 0.55,
            "layoutY": 0.2,
            "layoutWidth": 0.35,
            "layoutHeight": 0.5,
        },
    ]
    metadata = [
        {"duration": 2.0, "width": 640, "height": 360, "has_audio": False},
        {"duration": 2.0, "width": 640, "height": 360, "has_audio": False},
    ]

    filters, *_ = merge_videos.build_timeline_filter_graph(
        inputs,
        metadata,
        [],
        [],
        {
            "width": 1000,
            "height": 600,
            "fitMode": "contain",
            "canvasBackground": "black",
            "fps": 30,
            "includeAudio": False,
        },
    )
    graph = ";".join(filters)

    assert "overlay=x=100:y=120" in graph
    assert "overlay=x=550:y=120" in graph


def test_single_video_ignores_stale_multitrack_layout_and_fills_canvas():
    cells = merge_videos.layout_cells(
        [{
            "item": {
                "layoutCustom": True,
                "layoutX": 0,
                "layoutY": 0,
                "layoutWidth": 0.5,
                "layoutHeight": 0.5,
            },
        }],
        1920,
        1080,
    )

    assert cells == [(0, 0, 1920, 1080)]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg is not available")
def test_real_multitrack_export_produces_expected_canvas_and_audio(tmp_path):
    ffmpeg = shutil.which("ffmpeg")
    first = tmp_path / "first.mp4"
    second = tmp_path / "second.mp4"
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        str(first),
    ], check=True)
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=240x320:rate=24:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=660:duration=1",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        str(second),
    ], check=True)

    result_path = tmp_path / "result.json"
    merge_videos.run_merge({
        "inputs": [
            {"path": str(first), "startTime": 0, "trackIndex": 0},
            {"path": str(second), "startTime": 0.25, "trackIndex": 1},
        ],
        "audioTracks": [],
        "outputDir": str(tmp_path / "output"),
        "outputName": "multitrack",
        "width": 640,
        "height": 360,
        "fitMode": "contain",
        "canvasBackground": "white",
        "splitMode": "none",
        "splitValue": 600,
        "fps": 30,
        "crf": 23,
        "encoderPreset": "ultrafast",
        "includeAudio": True,
    }, result_path, tmp_path)

    output_path = Path(json.loads(result_path.read_text(encoding="utf-8"))["outputPaths"][0])
    metadata = merge_videos.probe_video(ffmpeg, output_path)
    assert metadata["width"] == 640
    assert metadata["height"] == 360
    assert metadata["has_audio"] is True
    assert metadata["duration"] >= 1.2
