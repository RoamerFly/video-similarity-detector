from __future__ import annotations

import importlib.util
import json
import os
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


def test_hardware_encoder_candidates_match_platform_and_codec():
    assert merge_videos.hardware_encoder_candidates("h264", "win32") == [
        "h264_nvenc", "h264_qsv", "h264_amf",
    ]
    assert merge_videos.hardware_encoder_candidates("h265", "darwin") == ["hevc_videotoolbox"]
    assert merge_videos.hardware_encoder_candidates("hevc", "linux") == ["hevc_nvenc", "hevc_qsv"]
    # VAAPI is intentionally excluded because it needs a device/hwupload path.
    assert "h264_vaapi" not in merge_videos.hardware_encoder_candidates("h264", "linux")


def test_hardware_encoding_args_map_quality_bitrate_and_preset():
    quality_args = merge_videos.video_encoding_args({
        "videoEncoder": "h264",
        "rateControl": "quality",
        "crf": 21,
        "encoderPreset": "slow",
    }, "h264_nvenc")
    assert quality_args == [
        "-c:v", "h264_nvenc", "-preset", "p6", "-rc:v", "vbr",
        "-cq", "21", "-b:v", "0", "-pix_fmt", "yuv420p",
    ]

    bitrate_args = merge_videos.video_encoding_args({
        "videoEncoder": "h265",
        "rateControl": "bitrate",
        "videoBitrate": 3500,
        "encoderPreset": "veryfast",
    }, "hevc_qsv")
    assert bitrate_args == [
        "-c:v", "hevc_qsv", "-preset", "veryfast", "-b:v", "3500k",
        "-pix_fmt", "nv12",
    ]
    assert merge_videos.video_encoding_args({"videoEncoder": "h264", "crf": 23}, "h264_videotoolbox")[-2:] == [
        "-pix_fmt", "yuv420p",
    ]
    assert "-q:v" in merge_videos.video_encoding_args({"videoEncoder": "h264", "crf": 23}, "h264_videotoolbox")


def test_hardware_two_pass_uses_native_options_without_external_pass_flags():
    config = {"rateControl": "bitrate", "twoPass": True}
    assert merge_videos.hardware_two_pass_args("h264_nvenc", config) == ["-multipass", "full"]
    assert merge_videos.hardware_two_pass_args("hevc_qsv", config) == ["-look_ahead", "1"]
    assert merge_videos.hardware_two_pass_args("h264_amf", config) == ["-vbaq", "1"]
    assert merge_videos.hardware_two_pass_args("h264_videotoolbox", config) == []
    assert merge_videos.hardware_two_pass_args("h264_nvenc", {"twoPass": False}) == []


def test_select_video_encoder_probes_once_and_force_cpu_bypasses_gpu(monkeypatch):
    merge_videos.GPU_ENCODER_PROBE_CACHE.clear()
    merge_videos.GPU_ENCODER_SELECTION_CACHE.clear()
    monkeypatch.setattr(merge_videos.sys, "platform", "win32")
    calls = []

    def fake_probe(ffmpeg, encoder):
        calls.append(encoder)
        return encoder == "h264_qsv"

    monkeypatch.setattr(merge_videos, "probe_hardware_encoder", fake_probe)
    config = {"videoEncoder": "h264"}
    selected = merge_videos.select_video_encoder("C:/ffmpeg.exe", config)
    assert selected == {"encoder": "h264_qsv", "is_hardware": True, "codec": "h264"}
    assert calls == ["h264_nvenc", "h264_qsv"]
    assert merge_videos.select_video_encoder("C:/ffmpeg.exe", config) == selected
    assert calls == ["h264_nvenc", "h264_qsv"]

    monkeypatch.setenv("VIDEO_SIM_FORCE_CPU", "1")
    forced = merge_videos.select_video_encoder("C:/other-ffmpeg.exe", config)
    assert forced == {"encoder": "libx264", "is_hardware": False, "codec": "h264"}
    assert calls == ["h264_nvenc", "h264_qsv"]


def test_probe_hardware_encoder_executes_a_real_one_frame_encode(monkeypatch):
    merge_videos.GPU_ENCODER_PROBE_CACHE.clear()
    captured = []

    class Completed:
        returncode = 0

    def fake_run(command, **kwargs):
        captured.append((command, kwargs))
        return Completed()

    monkeypatch.setattr(merge_videos.subprocess, "run", fake_run)
    assert merge_videos.probe_hardware_encoder("ffmpeg", "h264_nvenc") is True
    assert merge_videos.probe_hardware_encoder("ffmpeg", "h264_nvenc") is True
    assert len(captured) == 1
    command = captured[0][0]
    assert "-f" in command and command[command.index("-f") + 1] == "lavfi"
    assert "-frames:v" in command and command[command.index("-frames:v") + 1] == "1"
    assert command[command.index("-c:v") + 1] == "h264_nvenc"
    assert captured[0][1]["timeout"] == merge_videos.GPU_ENCODER_PROBE_TIMEOUT_SECONDS


def test_filter_buffered_frames_is_added_only_after_safe_graph_probe(monkeypatch):
    merge_videos.FILTER_BUFFERED_FRAMES_CACHE.clear()
    monkeypatch.setattr(merge_videos, "probe_filter_buffered_frames", lambda ffmpeg: True)
    assert merge_videos.filter_buffered_frames_args("ffmpeg", 4) == [
        "-filter_buffered_frames", "4",
    ]
    monkeypatch.setattr(merge_videos, "probe_filter_buffered_frames", lambda ffmpeg: False)
    assert merge_videos.filter_buffered_frames_args("ffmpeg-unsafe", 4) == []
    assert merge_videos.filter_buffered_frames_args("ffmpeg-unsafe", 0) == []


def test_gpu_failure_classifier_does_not_mask_filter_or_input_errors():
    assert merge_videos.is_gpu_encoder_failure(
        merge_videos.FFmpegCommandError(1, "[h264_nvenc] No capable devices found"), "h264_nvenc"
    ) is True
    assert merge_videos.is_gpu_encoder_failure(
        merge_videos.FFmpegCommandError(1, "Cannot allocate memory"), "h264_qsv"
    ) is False
    assert merge_videos.is_gpu_encoder_failure(
        merge_videos.FFmpegCommandError(1, "Error initializing output stream"), "h264_qsv"
    ) is False
    assert merge_videos.is_gpu_encoder_failure(
        merge_videos.FFmpegCommandError(1, "Error while filtering: Cannot allocate memory"), "h264_qsv"
    ) is False
    assert merge_videos.is_gpu_encoder_failure(
        merge_videos.FFmpegCommandError(1, "Error opening input: No such file or directory"), "h264_qsv"
    ) is False


def test_run_merge_retries_cpu_after_gpu_encoder_failure(tmp_path, monkeypatch):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"input-placeholder")
    commands = []

    monkeypatch.setattr(merge_videos, "resolve_ffmpeg", lambda project_root: "ffmpeg")
    monkeypatch.setattr(merge_videos, "probe_video", lambda ffmpeg, path: {
        "duration": 1.0, "width": 320, "height": 240, "fps": 24.0, "has_audio": False,
    })
    monkeypatch.setattr(merge_videos, "select_video_encoder", lambda ffmpeg, config: {
        "encoder": "h264_qsv", "is_hardware": True, "codec": "h264",
    })
    monkeypatch.setattr(merge_videos, "build_timeline_filter_graph", lambda *args, **kwargs: (
        ["[0:v]null[vout]"], 1.0, False,
    ))

    def fake_run(command, *args):
        commands.append(command)
        if len(commands) == 1:
            raise merge_videos.FFmpegCommandError(1, "[h264_qsv] No capable devices found")
        Path(command[-1]).write_bytes(b"cpu-output")

    monkeypatch.setattr(merge_videos, "run_ffmpeg_command", fake_run)
    result_path = tmp_path / "result.json"
    merge_videos.run_merge({
        "inputs": [{"path": str(source), "startTime": 0, "trackIndex": 0}],
        "audioTracks": [], "outputDir": str(tmp_path / "output"), "outputName": "retry",
        "width": 320, "height": 240, "fps": 24, "fitMode": "contain", "includeAudio": False,
        "videoEncoder": "h264", "rateControl": "quality", "crf": 23,
    }, result_path, tmp_path)

    assert len(commands) == 2
    assert commands[0][commands[0].index("-c:v") + 1] == "h264_qsv"
    assert commands[1][commands[1].index("-c:v") + 1] == "libx264"
    assert json.loads(result_path.read_text(encoding="utf-8"))["outputPaths"]


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


def test_dynamic_multitrack_graph_composes_local_intervals_then_concats():
    inputs = [
        {"path": "one.mp4", "startTime": 0, "trackIndex": 0, "trimStart": 0, "trimEnd": 2},
        {"path": "two.mp4", "startTime": 1, "trackIndex": 1, "trimStart": 0, "trimEnd": 2},
    ]
    metadata = [
        {"duration": 2.0, "width": 1920, "height": 1080, "fps": 30.0, "has_audio": False},
        {"duration": 2.0, "width": 1920, "height": 1080, "fps": 30.0, "has_audio": False},
    ]

    filters, duration, has_audio = merge_videos.build_timeline_filter_graph(
        inputs,
        metadata,
        [],
        [],
        {"width": 1280, "height": 720, "fps": 30, "fitMode": "contain", "includeAudio": False},
    )
    graph = ";".join(filters)

    assert duration == 3.0
    assert has_audio is False
    assert "concat=n=3:v=1:a=0[vbase]" in graph
    assert graph.count("overlay=") == 4
    assert "dynamiccanvas0_0" in graph
    assert "setpts=PTS+" not in graph


def test_dynamic_multitrack_graph_keeps_blank_sections_as_local_color_segments():
    inputs = [
        {"path": "one.mp4", "startTime": 0, "trackIndex": 0, "trimStart": 0, "trimEnd": 1},
        {"path": "two.mp4", "startTime": 0.5, "trackIndex": 1, "trimStart": 0, "trimEnd": 1},
        {"path": "three.mp4", "startTime": 3, "trackIndex": 2, "trimStart": 0, "trimEnd": 1},
    ]
    metadata = [
        {"duration": 1.0, "width": 640, "height": 360, "has_audio": False}
        for _ in inputs
    ]

    filters, duration, _ = merge_videos.build_timeline_filter_graph(
        inputs,
        metadata,
        [],
        [],
        {"width": 640, "height": 360, "fps": 30, "fitMode": "contain", "includeAudio": False},
    )
    graph = ";".join(filters)

    assert duration == 4.0
    assert "vgapdynamic" in graph
    assert "concat=n=5:v=1:a=0[vbase]" in graph
    assert "color=c=black:s=640x360:r=30:d=1.500000" in graph


def test_dynamic_graph_accepts_independently_seeked_section_inputs():
    inputs = [
        {"path": "one.mp4", "startTime": 0, "trackIndex": 0, "trimStart": 0, "trimEnd": 2},
        {"path": "two.mp4", "startTime": 1, "trackIndex": 1, "trimStart": 0, "trimEnd": 2},
    ]
    metadata = [
        {"duration": 2.0, "width": 1920, "height": 1080, "fps": 30.0, "has_audio": False},
        {"duration": 2.0, "width": 1920, "height": 1080, "fps": 30.0, "has_audio": False},
    ]
    filters, *_ = merge_videos.build_timeline_filter_graph(
        inputs,
        metadata,
        [],
        [],
        {"width": 1280, "height": 720, "fps": 30, "fitMode": "contain", "includeAudio": False},
        section_input_indices={(0, 0): 2, (1, 0): 3, (1, 1): 4, (2, 1): 5},
    )
    graph = ";".join(filters)

    assert "split=" not in graph
    assert "[2:v:0]trim=start=0.000000:end=1.000000" in graph
    assert "[4:v:0]trim=start=0.000000:end=1.000000" in graph


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


def test_high_resolution_custom_layout_uses_local_sections_instead_of_static_overlays():
    inputs = [
        {"path": "one.mp4", "startTime": 0, "trackIndex": 0, "trimStart": 0, "trimEnd": 2,
         "layoutCustom": True, "layoutX": 0, "layoutY": 0, "layoutWidth": 0.5, "layoutHeight": 1},
        {"path": "two.mp4", "startTime": 0, "trackIndex": 1, "trimStart": 0, "trimEnd": 2,
         "layoutCustom": True, "layoutX": 0.5, "layoutY": 0, "layoutWidth": 0.5, "layoutHeight": 1},
    ]
    metadata = [
        {"duration": 2.0, "width": 7680, "height": 4320, "fps": 30.0, "has_audio": False},
        {"duration": 2.0, "width": 7680, "height": 4320, "fps": 30.0, "has_audio": False},
    ]
    filters, duration, _ = merge_videos.build_timeline_filter_graph(
        inputs, metadata, [], [],
        {"width": 7680, "height": 4320, "fps": 30, "fitMode": "contain", "includeAudio": False},
        force_local_sections=True,
        section_input_indices={(0, 0): 2, (0, 1): 3},
    )
    graph = ";".join(filters)

    assert duration == 2.0
    assert "vstatic" not in graph
    assert "vsection0" in graph
    assert "[vsection0]null[vbase]" in graph


def test_high_resolution_interval_layer_limit_prevents_unbounded_overlay_graph():
    inputs = [
        {"path": f"clip-{index}.mp4", "startTime": 0, "trackIndex": index,
         "trimStart": 0, "trimEnd": 1}
        for index in range(9)
    ]
    metadata = [
        {"duration": 1.0, "width": 3840, "height": 2160, "fps": 30.0, "has_audio": False}
        for _ in inputs
    ]

    with pytest.raises(RuntimeError, match="单个区间最多支持 8"):
        merge_videos.build_timeline_filter_graph(
            inputs, metadata, [], [],
            {"width": 3840, "height": 2160, "fps": 30, "includeAudio": False},
        )


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


def test_timeline_boundary_snap_uses_frame_tolerance_at_30_and_60_fps():
    overlap_30, gap_30 = merge_videos.timeline_boundary_tolerances(30)
    overlap_60, gap_60 = merge_videos.timeline_boundary_tolerances(60)

    assert overlap_30 == pytest.approx(0.1)
    assert gap_30 == pytest.approx(1 / 30)
    assert overlap_60 == pytest.approx(0.05)
    assert gap_60 == pytest.approx(1 / 60)

    # An 84 ms container tail is a normal browser/FFmpeg discrepancy at 30fps,
    # but is too large to silently absorb in a 60fps edit.
    inputs = [
        {"path": f"clip-{index}.mp4", "startTime": float(index), "trackIndex": 0}
        for index in range(2)
    ]
    metadata = [
        {"duration": 1.084, "width": 1920, "height": 1080, "fps": 30.0, "has_audio": False}
        for _ in inputs
    ]
    assert merge_videos.timeline_composition_mode(
        merge_videos.prepare_video_items(inputs, metadata, fps=30)
    ) == "linear"
    assert merge_videos.timeline_composition_mode(
        merge_videos.prepare_video_items(inputs, metadata, fps=60)
    ) == "dynamic"


def test_seven_linear_micro_tail_clips_do_not_open_duplicate_section_inputs():
    inputs = [
        {"path": f"clip-{index}.mp4", "startTime": float(index), "trackIndex": 0}
        for index in range(7)
    ]
    metadata = [
        {"duration": 1.084, "width": 1440, "height": 2560, "fps": 30.0, "has_audio": False}
        for _ in inputs
    ]
    prepared = merge_videos.prepare_video_items(inputs, metadata, fps=30)

    assert merge_videos.timeline_composition_mode(prepared) == "linear"
    # The former path added one local input for each active interval (17 for
    # this timeline), in addition to the seven original inputs.
    assert merge_videos.dynamic_video_section_specs(
        inputs, metadata, force_local_sections=True, fps=30
    ) == []
    filters, duration, has_audio = merge_videos.build_timeline_filter_graph(
        inputs,
        metadata,
        [],
        [],
        {"width": 1920, "height": 2560, "fps": 30, "includeAudio": False},
    )
    graph = ";".join(filters)

    # The final clip has no following boundary to absorb its own coded tail;
    # only the six internal 84 ms tails are removed.
    assert duration == pytest.approx(7.084)
    assert has_audio is False
    assert "concat=n=7:v=1:a=0[vbase]" in graph
    assert "dynamiccanvas" not in graph


def test_real_same_track_overlap_stays_dynamic_and_uses_local_sections():
    inputs = [
        {"path": "first.mp4", "startTime": 0, "trackIndex": 0},
        {"path": "second.mp4", "startTime": 1.8, "trackIndex": 0},
    ]
    metadata = [
        {"duration": 2.0, "width": 1920, "height": 1080, "fps": 30.0, "has_audio": False},
        {"duration": 2.0, "width": 1920, "height": 1080, "fps": 30.0, "has_audio": False},
    ]
    prepared = merge_videos.prepare_video_items(inputs, metadata, fps=30)
    specs = merge_videos.dynamic_video_section_specs(inputs, metadata, fps=30)

    assert merge_videos.timeline_composition_mode(prepared) == "dynamic"
    assert specs
    assert len(specs) > len(inputs)


def test_same_track_blank_gap_is_preserved_by_boundary_normalization():
    inputs = [
        {"path": "first.mp4", "startTime": 0, "trackIndex": 0},
        {"path": "second.mp4", "startTime": 1.5, "trackIndex": 0},
    ]
    metadata = [
        {"duration": 1.0, "width": 640, "height": 360, "fps": 30.0, "has_audio": False},
        {"duration": 1.0, "width": 640, "height": 360, "fps": 30.0, "has_audio": False},
    ]
    filters, duration, _ = merge_videos.build_timeline_filter_graph(
        inputs,
        metadata,
        [],
        [],
        {"width": 640, "height": 360, "fps": 30, "includeAudio": False},
    )
    graph = ";".join(filters)

    assert duration == pytest.approx(2.5)
    assert "color=c=black:s=640x360:r=30:d=0.500000" in graph
    assert "concat=n=3:v=1:a=0[vbase]" in graph


def test_audio_delay_follows_snapped_video_boundary():
    inputs = [
        {"path": "first.mp4", "startTime": 0, "trackIndex": 0},
        {"path": "second.mp4", "startTime": 1.0, "trackIndex": 0},
    ]
    metadata = [
        {"duration": 1.084, "width": 640, "height": 360, "fps": 30.0, "has_audio": True},
        {"duration": 1.084, "width": 640, "height": 360, "fps": 30.0, "has_audio": True},
    ]
    filters, duration, has_audio = merge_videos.build_timeline_filter_graph(
        inputs,
        metadata,
        [],
        [],
        {"width": 640, "height": 360, "fps": 30, "includeAudio": True},
    )
    graph = ";".join(filters)

    assert duration == pytest.approx(2.084)
    assert has_audio is True
    assert "[0:a:0]atrim=start=0.000000:end=1.000000" in graph
    assert "adelay=1000:all=1[clipa1]" in graph


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


def test_text_tracks_use_one_ass_pipeline_when_subtitle_path_is_provided(tmp_path: Path):
    inputs = [{"path": "one.mp4", "startTime": 0, "trackIndex": 0, "trimStart": 0, "trimEnd": 3}]
    metadata = [{"duration": 3.0, "width": 1280, "height": 720, "has_audio": False}]
    subtitle_path = tmp_path / "timeline.ass"

    filters, _, _ = merge_videos.build_timeline_filter_graph(
        inputs,
        metadata,
        [],
        [],
        {
            "width": 1280,
            "height": 720,
            "fps": 30,
            "fitMode": "contain",
            "includeAudio": False,
            "textTracks": [
                {"text": "第一条", "startTime": 0, "duration": 1, "x": 0.5, "y": 0.5, "fontSize": 32},
                {"text": "第二条", "startTime": 1, "duration": 1, "x": 0.5, "y": 0.5, "fontSize": 32},
            ],
        },
        subtitle_path=subtitle_path,
    )
    graph = ";".join(filters)
    ass = subtitle_path.read_text(encoding="utf-8-sig")

    assert graph.count("subtitles=") == 1
    assert "drawtext=" not in graph
    assert ass.count("Style: MergeText") == 2
    assert ass.count("Dialogue:") == 2
    assert "第一条" in ass and "第二条" in ass


def test_high_resolution_memory_budget_does_not_use_fixed_sixteen_frame_queue():
    sixteen_gib = 16 * 1024 * 1024 * 1024

    assert merge_videos.merge_memory_limits(
        3840 * 2160, input_count=7, available_memory=sixteen_gib,
    )[1] <= 16
    assert merge_videos.merge_memory_limits(
        7680 * 4320, input_count=7, available_memory=sixteen_gib,
    )[1] == 4
    assert merge_videos.merge_memory_limits(
        16384 * 16384, input_count=7, available_memory=sixteen_gib,
    )[1] == 1
    assert merge_videos.merge_encoder_threads(3840 * 2160, available_cores=8) == 3


def test_downsampling_happens_before_expensive_scaling_when_source_fps_is_higher():
    filter_text, *_ = merge_videos.build_video_filter(
        0,
        {"duration": 3.0, "width": 3840, "height": 2160, "fps": 60.0, "has_audio": False},
        {},
        {"width": 1920, "height": 1080, "fitMode": "contain", "fps": 30},
    )

    assert filter_text.index("fps=30") < filter_text.index("scale=1920:1080")


def test_dynamic_section_input_budget_falls_back_before_opening_quadratic_inputs():
    inputs = [
        {
            "path": f"C:/clips/clip-{index}.mp4",
            "startTime": index * 0.01,
            "trackIndex": index % 2,
            "trimStart": 0,
            "trimEnd": 20,
        }
        for index in range(40)
    ]
    metadata = [
        {"duration": 20.0, "width": 1920, "height": 1080, "has_audio": False}
        for _ in inputs
    ]

    # Forty heavily overlapping clips would otherwise expand to 1,600
    # independently seeked FFmpeg inputs.  Returning an empty plan selects the
    # local-section graph backed by one original input per clip.
    assert merge_videos.dynamic_video_section_specs(inputs, metadata) == []
    filters, _, _ = merge_videos.build_timeline_filter_graph(
        inputs,
        metadata,
        [],
        [],
        {"width": 1920, "height": 1080, "fps": 30, "includeAudio": False},
    )
    graph = ";".join(filters)
    assert "split=" in graph
    assert "concat=n=" in graph


def test_subtitle_font_directory_contains_only_the_selected_font(tmp_path: Path):
    source = tmp_path / "selected-font.ttf"
    source.write_bytes(b"font-placeholder")
    font_dir = tmp_path / "private-fonts"

    prepared = merge_videos.prepare_subtitle_font_dir(str(source), font_dir)

    assert prepared == font_dir
    assert [path.name for path in font_dir.iterdir()] == [source.name]
    assert (font_dir / source.name).read_bytes() == source.read_bytes()


def test_compositor_budget_and_threads_adapt_to_memory_pressure(monkeypatch):
    hd_metadata = [{"width": 1920, "height": 1080}]
    uhd_metadata = [{"width": 3840, "height": 2160}]

    assert merge_videos.dynamic_compositor_budget(1920, 1080, hd_metadata) == 1600
    assert merge_videos.dynamic_compositor_budget(3840, 2160, uhd_metadata) == 400
    monkeypatch.setattr(merge_videos.os, "cpu_count", lambda: 8)
    assert merge_videos.merge_thread_limits(8)[0] == 1
    assert merge_videos.merge_thread_limits(1)[1] == 2
    assert merge_videos.merge_thread_limits(8)[1] == 1


def test_output_format_and_collision_names_use_supported_containers(tmp_path, monkeypatch):
    assert merge_videos.normalize_output_format(".MKV") == "mkv"
    assert merge_videos.normalize_output_format(None) == "mp4"
    with pytest.raises(RuntimeError, match="仅支持"):
        merge_videos.normalize_output_format("avi")

    output_dir = tmp_path / "output"
    output_dir.mkdir()
    existing = output_dir / "merged.mkv"
    existing.write_bytes(b"existing")
    monkeypatch.setattr(merge_videos.time, "time", lambda: 1_728_000_000)
    candidate = merge_videos.unique_output_path(output_dir, "merged", ".mkv")
    assert candidate.name == "merged_1728000000.mkv"


def test_output_collision_same_second_never_overwrites(tmp_path, monkeypatch):
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    monkeypatch.setattr(merge_videos.time, "time", lambda: 1_728_000_000)
    (output_dir / "merged.mp4").write_bytes(b"first")
    (output_dir / "merged_1728000000.mp4").write_bytes(b"second")
    candidate = merge_videos.unique_output_path(output_dir, "merged", ".mp4")
    assert candidate.name == "merged_1728000000_1.mp4"
    assert (output_dir / "merged.mp4").read_bytes() == b"first"


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


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or os.environ.get("VIDEO_SIM_RUN_8K_TEST") != "1",
    reason="Set VIDEO_SIM_RUN_8K_TEST=1 to run the resource-intensive 8K smoke test",
)
def test_real_minimal_8k_export_has_a_bounded_merge_path(tmp_path, monkeypatch):
    ffmpeg = shutil.which("ffmpeg")
    source = tmp_path / "8k-source.mp4"
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=16x16:r=1:duration=1",
        "-frames:v", "1", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", str(source),
    ], check=True)
    monkeypatch.setenv("VIDEO_SIM_FORCE_CPU", "1")
    result_path = tmp_path / "8k-result.json"
    merge_videos.run_merge({
        "inputs": [{"path": str(source), "startTime": 0, "trackIndex": 0}],
        "audioTracks": [], "outputDir": str(tmp_path / "output"), "outputName": "8k",
        "width": 7680, "height": 4320, "fps": 1, "fitMode": "contain", "includeAudio": False,
        "videoEncoder": "h264", "rateControl": "quality", "crf": 35,
        "encoderPreset": "ultrafast",
    }, result_path, tmp_path)
    output_path = Path(json.loads(result_path.read_text(encoding="utf-8"))["outputPaths"][0])
    output_metadata = merge_videos.probe_video(ffmpeg, output_path)
    assert output_metadata["width"] == 7680
    assert output_metadata["height"] == 4320
