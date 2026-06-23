import json
import io
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts.batch_compare import (
    emit_video_context,
    emit_video_quarantined,
    quarantine_video,
    unique_quarantine_path,
    validate_video_stream,
)


def test_emit_video_context_writes_structured_stderr_marker(capsys, tmp_path: Path):
    video_path = tmp_path / "损坏|视频.mp4"

    emit_video_context(video_path, "index")

    captured = capsys.readouterr()
    assert captured.out == ""
    prefix, payload = captured.err.strip().split("|", 1)
    assert prefix == "ANALYSIS_VIDEO_CONTEXT"
    assert json.loads(payload) == {
        "path": str(video_path.resolve()),
        "phase": "index",
    }


def test_emit_video_quarantined_writes_ui_event(capsys, tmp_path: Path):
    original = tmp_path / "broken.mp4"
    destination = tmp_path / "data" / "error_videos" / "broken.mp4"

    emit_video_quarantined(original, destination, remaining_videos=4, removed_videos=2)

    prefix, payload = capsys.readouterr().out.strip().split("|", 1)
    assert prefix == "ANALYSIS_VIDEO_QUARANTINED"
    assert json.loads(payload) == {
        "originalPath": str(original.resolve()),
        "destinationPath": str(destination.resolve()),
        "remainingVideos": 4,
        "removedVideos": 2,
        "moved": True,
    }


def test_quarantine_video_moves_file_and_avoids_name_collision(tmp_path: Path):
    source = tmp_path / "videos" / "broken.mp4"
    source.parent.mkdir()
    source.write_bytes(b"broken")
    error_dir = tmp_path / "data" / "error_videos"
    error_dir.mkdir(parents=True)
    (error_dir / "broken.mp4").write_bytes(b"existing")

    destination = quarantine_video(source, error_dir)

    assert not source.exists()
    assert destination.name == "broken_1.mp4"
    assert destination.read_bytes() == b"broken"
    assert unique_quarantine_path(error_dir, "broken.mp4").name == "broken_2.mp4"


def test_validate_video_stream_stops_after_first_ffmpeg_error(tmp_path: Path):
    process = MagicMock()
    process.stderr = io.StringIO(
        "".join(
            "[h264 @ 0001] Invalid NAL unit size (10 > 2).\n"
            for _ in range(20)
        )
    )
    process.wait.return_value = -15

    with patch("scripts.batch_compare.subprocess.Popen", return_value=process):
        error = validate_video_stream("ffmpeg", tmp_path / "broken.mp4")

    assert "Invalid NAL unit size" in error
    assert "20 条严重码流错误" in error
    process.terminate.assert_called_once()


def test_validate_video_stream_accepts_a_few_missing_picture_warnings(tmp_path: Path):
    process = MagicMock()
    process.stderr = io.StringIO(
        "[h264 @ 0001] missing picture in access unit with size 5\n"
        "[h264 @ 0001] missing picture in access unit with size 5\n"
    )
    process.wait.return_value = 0

    with patch("scripts.batch_compare.subprocess.Popen", return_value=process):
        error = validate_video_stream("ffmpeg", tmp_path / "playable.mp4")

    assert error is None
    process.terminate.assert_not_called()


def test_error_tolerance_presets_change_quarantine_threshold(tmp_path: Path):
    lines = "".join(
        "[h264 @ 0001] Invalid NAL unit size (10 > 2).\n"
        for _ in range(20)
    )

    strict_process = MagicMock()
    strict_process.stderr = io.StringIO(lines)
    strict_process.wait.return_value = -15
    with patch("scripts.batch_compare.subprocess.Popen", return_value=strict_process):
        strict_error = validate_video_stream(
            "ffmpeg",
            tmp_path / "broken.mp4",
            "strict",
        )

    lenient_process = MagicMock()
    lenient_process.stderr = io.StringIO(lines)
    lenient_process.wait.return_value = 0
    with patch("scripts.batch_compare.subprocess.Popen", return_value=lenient_process):
        lenient_error = validate_video_stream(
            "ffmpeg",
            tmp_path / "playable.mp4",
            "lenient",
        )

    assert "5 条严重码流错误" in strict_error
    assert lenient_error is None
