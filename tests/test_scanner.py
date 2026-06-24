from pathlib import Path
import sys
import types


decord_stub = types.ModuleType("decord")
decord_stub.VideoReader = object
decord_stub.cpu = lambda *_args, **_kwargs: None
sys.modules.setdefault("decord", decord_stub)

from video_sim import scanner


def test_scan_videos_skips_unreadable_subdirectories(tmp_path: Path, monkeypatch) -> None:
    readable_dir = tmp_path / "readable"
    blocked_dir = tmp_path / "blocked"
    readable_dir.mkdir()
    blocked_dir.mkdir()
    video_path = readable_dir / "sample.mp4"
    hidden_video = blocked_dir / "hidden.mp4"
    video_path.write_bytes(b"video")
    hidden_video.write_bytes(b"hidden")

    real_scandir = scanner.os.scandir

    def guarded_scandir(path):
        if Path(path).name == "blocked":
            raise OSError("permission denied")
        return real_scandir(path)

    monkeypatch.setattr(scanner.os, "scandir", guarded_scandir)

    assert scanner.scan_videos(tmp_path, recursive=True) == [video_path]
    assert [item.path for item in scanner.VideoScanner(tmp_path).scan(recursive=True)] == [video_path]
