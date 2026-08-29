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


def test_video_encoding_args_support_quality_and_average_bitrate():
    assert merge_videos.video_encoding_args({
        "videoEncoder": "h264",
        "rateControl": "quality",
        "crf": 21,
        "encoderPreset": "slow",
    }) == ["-c:v", "libx264", "-preset", "slow", "-crf", "21", "-pix_fmt", "yuv420p"]

    assert merge_videos.video_encoding_args({
        "videoEncoder": "h265",
        "rateControl": "bitrate",
        "videoBitrate": 3500,
        "encoderPreset": "veryfast",
    }) == ["-c:v", "libx265", "-preset", "veryfast", "-b:v", "3500k", "-pix_fmt", "yuv420p"]


def test_encoding_args_reject_unsupported_values_and_clamp_bitrates():
    assert merge_videos.video_encoding_args({
        "videoEncoder": "unknown",
        "rateControl": "bitrate",
        "videoBitrate": 999999,
        "encoderPreset": "not-a-preset",
    }) == ["-c:v", "libx264", "-preset", "medium", "-b:v", "100000k", "-pix_fmt", "yuv420p"]
    assert merge_videos.audio_encoding_args({"audioBitrate": 2}) == ["-c:a", "aac", "-b:a", "32k"]


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


def test_fixed_custom_multitrack_layout_avoids_interval_splits():
    inputs = [
        {"path": "one.mp4", "startTime": 0, "trackIndex": 0, "layoutCustom": True, "layoutX": 0, "layoutY": 0, "layoutWidth": 0.5, "layoutHeight": 1},
        {"path": "two.mp4", "startTime": 0, "trackIndex": 1, "layoutCustom": True, "layoutX": 0.5, "layoutY": 0, "layoutWidth": 0.5, "layoutHeight": 1},
    ]
    metadata = [
        {"duration": 10.0, "width": 1920, "height": 1080, "has_audio": False},
        {"duration": 10.0, "width": 1920, "height": 1080, "has_audio": False},
    ]
    filters, _, _ = merge_videos.build_timeline_filter_graph(
        inputs, metadata, [], [], {"width": 1280, "height": 720, "fps": 30, "includeAudio": False},
    )
    graph = ";".join(filters)

    assert "split=" not in graph
    assert "vstatic0" in graph
    assert "repeatlast=0" in graph


def test_gapless_single_track_uses_low_memory_concat_graph():
    inputs = [
        {"path": "one.mp4", "startTime": 0, "trackIndex": 0, "trimStart": 0, "trimEnd": 2},
        {"path": "two.mp4", "startTime": 2, "trackIndex": 0, "trimStart": 0, "trimEnd": 3},
    ]
    metadata = [
        {"duration": 2.0, "width": 1920, "height": 1080, "has_audio": False},
        {"duration": 3.0, "width": 1920, "height": 1080, "has_audio": False},
    ]

    filters, duration, has_audio = merge_videos.build_timeline_filter_graph(
        inputs, metadata, [], [],
        {"width": 1280, "height": 720, "fps": 30, "includeAudio": False},
    )
    graph = ";".join(filters)

    assert duration == 5.0
    assert has_audio is False
    assert "concat=n=2:v=1:a=0[vbase]" in graph
    assert "overlay=" not in graph


def test_non_overlapping_timeline_gaps_use_concat_instead_of_full_canvas_overlays():
    inputs = [
        {"path": "one.mp4", "startTime": 1, "trackIndex": 0, "trimStart": 0, "trimEnd": 2},
        {"path": "two.mp4", "startTime": 5, "trackIndex": 1, "trimStart": 0, "trimEnd": 2},
    ]
    metadata = [
        {"duration": 2.0, "width": 1920, "height": 1080, "has_audio": False},
        {"duration": 2.0, "width": 1280, "height": 720, "has_audio": False},
    ]

    filters, duration, has_audio = merge_videos.build_timeline_filter_graph(
        inputs, metadata, [], [],
        {"width": 1280, "height": 720, "fps": 30, "includeAudio": False},
    )
    graph = ";".join(filters)

    assert duration == 7.0
    assert has_audio is False
    assert "color=c=black:s=1280x720:r=30:d=1.000000" in graph
    assert "color=c=black:s=1280x720:r=30:d=2.000000" in graph
    assert "concat=n=4:v=1:a=0[vbase]" in graph
    assert "overlay=" not in graph


def test_audio_tail_extends_video_canvas_and_disable_audio_omits_all_audio():
    inputs = [{"id": "clip-1", "path": "one.mp4", "startTime": 0, "trackIndex": 0}]
    metadata = [{"duration": 2.0, "width": 1280, "height": 720, "has_audio": True}]
    audio_tracks = [{"path": "music.mp3", "startTime": 1, "trimStart": 0, "trimEnd": 6}]
    audio_metadata = [{"duration": 10.0}]

    filters, duration, has_audio = merge_videos.build_timeline_filter_graph(
        inputs, metadata, audio_tracks, audio_metadata,
        {"width": 1280, "height": 720, "fps": 30, "includeAudio": True},
    )
    graph = ";".join(filters)
    assert duration == 7.0
    assert has_audio is True
    assert "tpad=stop_mode=add:stop_duration=5.000000" in graph
    assert "atrim=duration=7.000000" in graph

    filters, duration, has_audio = merge_videos.build_timeline_filter_graph(
        inputs, metadata, audio_tracks, audio_metadata,
        {"width": 1280, "height": 720, "fps": 30, "includeAudio": False},
    )
    assert duration == 2.0
    assert has_audio is False
    assert "externala" not in ";".join(filters)


def test_extracted_clip_audio_replaces_automatic_source_audio():
    inputs = [{"id": "clip-1", "path": "one.mp4", "startTime": 0, "trackIndex": 0}]
    metadata = [{"duration": 2.0, "width": 1280, "height": 720, "has_audio": True}]
    audio_tracks = [{
        "path": "one.mp4", "startTime": 0, "trimStart": 0, "trimEnd": 2,
        "sourceType": "video", "sourceClipId": "clip-1",
    }]

    filters, _, has_audio = merge_videos.build_timeline_filter_graph(
        inputs, metadata, audio_tracks, [{"duration": 2.0}],
        {"width": 1280, "height": 720, "fps": 30, "includeAudio": True},
    )
    graph = ";".join(filters)
    assert has_audio is True
    assert "[externala0]" in graph
    assert "[clipa0]" not in graph

    audio_tracks[0]["_inputIndex"] = 0
    filters, _, has_audio = merge_videos.build_timeline_filter_graph(
        inputs, metadata, audio_tracks, [{"duration": 2.0}],
        {"width": 1280, "height": 720, "fps": 30, "includeAudio": True},
    )
    graph = ";".join(filters)
    assert has_audio is True
    assert "[0:a:0]atrim=" in graph


def test_muted_external_audio_does_not_extend_the_output_or_create_filters():
    inputs = [{"id": "clip-1", "path": "one.mp4", "startTime": 0, "trackIndex": 0}]
    metadata = [{"duration": 2.0, "width": 1280, "height": 720, "has_audio": False}]
    audio_tracks = [{"path": "music.mp3", "startTime": 10, "trimStart": 0, "trimEnd": 20, "muted": True}]

    filters, duration, has_audio = merge_videos.build_timeline_filter_graph(
        inputs, metadata, audio_tracks, [{"duration": 30.0}],
        {"width": 1280, "height": 720, "fps": 30, "includeAudio": True},
    )
    graph = ";".join(filters)

    assert duration == 2.0
    assert has_audio is False
    assert "externala0" not in graph


def test_filter_graph_is_written_to_a_file(tmp_path):
    graph_path = tmp_path / "timeline.ffscript"
    merge_videos.write_filter_graph(graph_path, ["[0:v]null[vout]", "[0:a]anull[aout]"])
    assert graph_path.read_text(encoding="utf-8") == "[0:v]null[vout];[0:a]anull[aout]"


def test_dynamic_multitrack_graph_has_a_safe_complexity_limit():
    inputs = [
        {
            "path": f"clip-{index}.mp4",
            "startTime": index * 0.01,
            "trackIndex": index % 2,
            "trimStart": 0,
            "trimEnd": 20,
        }
        for index in range(60)
    ]
    metadata = [
        {"duration": 20.0, "width": 640, "height": 360, "has_audio": False}
        for _ in inputs
    ]

    with pytest.raises(RuntimeError, match="超过安全上限"):
        merge_videos.build_timeline_filter_graph(
            inputs, metadata, [], [],
            {"width": 1280, "height": 720, "fps": 30, "includeAudio": False},
        )


def test_compositor_budget_and_threads_adapt_to_memory_pressure(monkeypatch):
    hd_metadata = [{"width": 1920, "height": 1080}]
    uhd_metadata = [{"width": 3840, "height": 2160}]

    assert merge_videos.dynamic_compositor_budget(1920, 1080, hd_metadata) == 1600
    assert merge_videos.dynamic_compositor_budget(3840, 2160, uhd_metadata) == 400
    monkeypatch.setattr(merge_videos.os, "cpu_count", lambda: 8)
    assert merge_videos.merge_thread_limits(8)[0] == 1
    assert merge_videos.merge_thread_limits(1)[1] == 2
    assert merge_videos.merge_thread_limits(8)[1] == 1


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
        "videoEncoder": "h264",
        "rateControl": "bitrate",
        "videoBitrate": 700,
        "twoPass": True,
        "encoderPreset": "ultrafast",
        "audioBitrate": 96,
        "includeAudio": True,
    }, result_path, tmp_path)

    output_path = Path(json.loads(result_path.read_text(encoding="utf-8"))["outputPaths"][0])
    metadata = merge_videos.probe_video(ffmpeg, output_path)
    assert metadata["width"] == 640
    assert metadata["height"] == 360
    assert metadata["has_audio"] is True
    assert metadata["duration"] >= 1.2
