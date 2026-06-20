from __future__ import annotations

import importlib.util
from pathlib import Path


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
