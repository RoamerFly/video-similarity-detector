"""Independent pixel oracles for the shared frame preprocessing paths."""

from pathlib import Path

import cv2
import imagehash
import numpy as np
from PIL import Image
import pytest

from video_sim.frame_sampler import DynamicFrameSampler, _rgb_to_bgr
from video_sim.preprocess import (
    PortraitRotation,
    PreprocessConfig,
    ResizeMode,
    prepare_frame_geometry,
    preprocess_frame_for_clip,
    preprocess_frame_for_hash,
)


def _legacy_resize(frame, target_size, mode, interpolation):
    h, w = frame.shape[:2]
    if h == 0 or w == 0:
        return np.zeros((target_size, target_size, 3), dtype=np.uint8)
    if mode == ResizeMode.CENTER_CROP:
        scale = target_size / min(h, w)
        new_h, new_w = int(h * scale), int(w * scale)
        resized = cv2.resize(frame, (new_w, new_h), interpolation=interpolation)
        start_h = (new_h - target_size) // 2
        start_w = (new_w - target_size) // 2
        cropped = resized[start_h:start_h + target_size, start_w:start_w + target_size]
        if cropped.shape[:2] != (target_size, target_size):
            cropped = cv2.resize(cropped, (target_size, target_size), interpolation=interpolation)
        return cropped

    scale = target_size / max(h, w)
    new_h, new_w = int(h * scale), int(w * scale)
    resized = cv2.resize(frame, (new_w, new_h), interpolation=interpolation)
    canvas = np.zeros((target_size, target_size, 3), dtype=np.uint8)
    start_h = (target_size - new_h) // 2
    start_w = (target_size - new_w) // 2
    canvas[start_h:start_h + new_h, start_w:start_w + new_w] = resized
    return canvas


def _legacy_prepare(frame, config):
    result = frame.copy()
    if config.crop_black_borders:
        gray = cv2.cvtColor(result, cv2.COLOR_BGR2GRAY)
        mask = gray > config.border_threshold
        rows = np.any(mask, axis=1)
        cols = np.any(mask, axis=0)
        h, w = result.shape[:2]
        if np.any(rows) and np.any(cols):
            rmin, rmax = np.where(rows)[0][[0, -1]]
            cmin, cmax = np.where(cols)[0][[0, -1]]
            min_h_border = int(h * config.border_crop_ratio)
            min_w_border = int(w * config.border_crop_ratio)
            top = rmin if rmin >= min_h_border else 0
            bottom = rmax + 1 if h - rmax - 1 >= min_h_border else h
            left = cmin if cmin >= min_w_border else 0
            right = cmax + 1 if w - cmax - 1 >= min_w_border else w
            result = result[top:bottom, left:right]
    h, w = result.shape[:2]
    if h > w:
        result = cv2.rotate(
            result,
            cv2.ROTATE_90_COUNTERCLOCKWISE
            if config.portrait_rotation == PortraitRotation.LEFT_90
            else cv2.ROTATE_90_CLOCKWISE,
        )
    return result


def _legacy_preprocess(frame, config, interpolation):
    result = _legacy_prepare(frame, config)
    target_size = max(1, int(config.input_size))
    if result.shape[:2] != (target_size, target_size):
        return _legacy_resize(result, target_size, config.resize_mode, interpolation)
    return result


def _frame(height, width):
    y, x = np.indices((height, width))
    return np.stack(
        ((x * 17 + y * 3) % 256, (x * 5 + y * 29) % 256, (x * 41 + y * 7) % 256),
        axis=-1,
    ).astype(np.uint8)


@pytest.mark.parametrize("shape", [(17, 29), (29, 17), (23, 23), (5, 7)])
@pytest.mark.parametrize("crop", [False, True])
@pytest.mark.parametrize("mode", [ResizeMode.CENTER_CROP, ResizeMode.LETTERBOX])
@pytest.mark.parametrize("rotation", [PortraitRotation.LEFT_90, PortraitRotation.RIGHT_90])
@pytest.mark.parametrize("target_size", [224, 336])
def test_public_preprocess_matches_independent_legacy_oracle(
    shape, crop, mode, rotation, target_size
):
    frame = _frame(*shape)
    if crop:
        frame[:2, :] = 0
        frame[-2:, :] = 0
        frame[:, :2] = 0
        frame[:, -2:] = 0
    original = frame.copy()
    config = PreprocessConfig(
        crop_black_borders=crop,
        resize_mode=mode,
        input_size=target_size,
        portrait_rotation=rotation,
    )

    expected_hash = _legacy_preprocess(frame, config, cv2.INTER_AREA)
    expected_clip = _legacy_preprocess(frame, config, cv2.INTER_LINEAR)
    actual_hash = preprocess_frame_for_hash(frame, config)
    actual_clip = preprocess_frame_for_clip(frame, config)

    assert np.array_equal(actual_hash, expected_hash)
    assert np.array_equal(actual_clip, expected_clip)
    assert np.array_equal(frame, original)
    assert actual_hash is not frame
    assert actual_clip is not frame


def test_prepare_geometry_is_readonly_view_without_changing_input_flags():
    frame = _frame(11, 13)
    was_writeable = frame.flags.writeable
    prepared = prepare_frame_geometry(frame, PreprocessConfig())

    assert prepared.flags.writeable is False
    assert frame.flags.writeable is was_writeable
    assert np.shares_memory(prepared, frame)
    with pytest.raises(ValueError):
        prepared[0, 0, 0] = 0


def test_public_preprocess_copies_target_sized_and_all_black_frames():
    frame = np.zeros((224, 224, 3), dtype=np.uint8)
    config = PreprocessConfig(crop_black_borders=True, input_size=224)
    result = preprocess_frame_for_clip(frame, config)

    assert np.array_equal(result, frame)
    assert result is not frame
    assert not np.shares_memory(result, frame)
    assert result.flags.writeable


def test_noncontiguous_and_rgb_dtype_conversion_keep_legacy_pixels():
    source = _frame(18, 26)
    frame = source[:, ::2, :]
    config = PreprocessConfig(input_size=32)
    expected = _legacy_preprocess(frame, config, cv2.INTER_AREA)
    assert np.array_equal(preprocess_frame_for_hash(frame, config), expected)

    gray = np.arange(35, dtype=np.uint8).reshape(5, 7)
    rgba = np.concatenate([_frame(5, 7), np.full((5, 7, 1), 99, dtype=np.uint8)], axis=-1)
    assert np.array_equal(_rgb_to_bgr(gray), cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR))
    assert np.array_equal(_rgb_to_bgr(rgba), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGR))

    rgb16 = _frame(5, 7).astype(np.uint16) * 2
    expected_rgb16 = cv2.cvtColor(rgb16.astype(np.uint8), cv2.COLOR_RGB2BGR)
    assert np.array_equal(_rgb_to_bgr(rgb16), expected_rgb16)


def test_sampler_retained_clip_and_phash_match_legacy_pixels(tmp_path):
    frame = _frame(13, 21)
    config = PreprocessConfig(
        crop_black_borders=False,
        resize_mode=ResizeMode.LETTERBOX,
        input_size=33,
    )
    sampler = DynamicFrameSampler(cache_dir=tmp_path, preprocess_config=config)
    retained = []
    sampler._consider_frame(
        frame=frame,
        frame_index=0,
        timestamp=0.0,
        retained_frames=retained,
        last_retained_hash=None,
        last_retained_index=-1,
        max_gap_frames=100,
        video_path=Path("oracle.mp4"),
    )
    assert len(retained) == 1
    expected_clip_bgr = _legacy_preprocess(frame, config, cv2.INTER_LINEAR)
    expected_hash_bgr = _legacy_preprocess(frame, config, cv2.INTER_AREA)
    assert np.array_equal(retained[0].clip_frame, cv2.cvtColor(expected_clip_bgr, cv2.COLOR_BGR2RGB))
    expected_hash = imagehash.phash(Image.fromarray(cv2.cvtColor(expected_hash_bgr, cv2.COLOR_BGR2RGB)))
    assert retained[0].phash == str(expected_hash)
