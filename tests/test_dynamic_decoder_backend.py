"""Tests for the OpenCV-first dynamic decoder selection contract."""

from pathlib import Path

import pytest

from video_sim.frame_sampler import (
    DECODER_BACKEND_DECORD,
    DECODER_BACKEND_OPENCV,
    DynamicFrameSampler,
)
from video_sim.embedder import FrameEmbeddingCache
from video_sim.metrics import RecognitionMetrics
from video_sim.recognition_contract import FRAME_CACHE_SCHEMA_VERSION


def test_step_one_prefers_opencv_without_calling_decord(monkeypatch, tmp_path: Path):
    video = tmp_path / "video.mp4"
    video.touch()
    sampler = DynamicFrameSampler(cache_dir=tmp_path, frame_step=1)
    calls = []

    def opencv(_path, _progress=None, retained_frames=None, retained_callback=None):
        calls.append(DECODER_BACKEND_OPENCV)
        sampler.retained_count = 1
        return retained_frames or []

    def decord(*_args, **_kwargs):
        calls.append(DECODER_BACKEND_DECORD)
        raise AssertionError("Decord must not run on the normal step=1 path")

    monkeypatch.setattr(sampler, "_sample_with_opencv", opencv)
    monkeypatch.setattr(sampler, "_sample_with_decord", decord)

    sampler.sample(video)

    assert calls == [DECODER_BACKEND_OPENCV]
    assert sampler.decoder_backend == DECODER_BACKEND_OPENCV
    assert sampler.last_decoder_backend == DECODER_BACKEND_OPENCV
    assert sampler.decoder_fallback is False
    assert sampler.decoder_backend_history == [DECODER_BACKEND_OPENCV]


def test_opencv_early_failure_falls_back_to_decord(monkeypatch, tmp_path: Path):
    video = tmp_path / "video.mp4"
    video.touch()
    sampler = DynamicFrameSampler(cache_dir=tmp_path, frame_step=1)
    calls = []

    def opencv(*_args, **_kwargs):
        calls.append(DECODER_BACKEND_OPENCV)
        raise RuntimeError("opencv failed before first retained frame")

    def decord(_path, _progress=None, retained_frames=None, retained_callback=None):
        calls.append(DECODER_BACKEND_DECORD)
        sampler.retained_count = 1
        return retained_frames or []

    monkeypatch.setattr(sampler, "_sample_with_opencv", opencv)
    monkeypatch.setattr(sampler, "_sample_with_decord", decord)

    sampler.sample(video)

    assert calls == [DECODER_BACKEND_OPENCV, DECODER_BACKEND_DECORD]
    assert sampler.decoder_backend == DECODER_BACKEND_DECORD
    assert sampler.decoder_fallback is True
    assert "opencv failed" in sampler.decoder_fallback_reason
    assert sampler.decoder_backend_history == [
        DECODER_BACKEND_OPENCV,
        DECODER_BACKEND_DECORD,
    ]


def test_failure_after_opencv_emitted_frame_does_not_restart_with_decord(
    monkeypatch, tmp_path: Path
):
    video = tmp_path / "video.mp4"
    video.touch()
    sampler = DynamicFrameSampler(cache_dir=tmp_path, frame_step=1)
    decord_called = False

    def opencv(*_args, **_kwargs):
        sampler.retained_count = 1
        raise RuntimeError("opencv failed after first retained frame")

    def decord(*_args, **_kwargs):
        nonlocal decord_called
        decord_called = True
        return []

    monkeypatch.setattr(sampler, "_sample_with_opencv", opencv)
    monkeypatch.setattr(sampler, "_sample_with_decord", decord)

    with pytest.raises(RuntimeError, match="after first retained frame"):
        sampler.sample(video)

    assert decord_called is False
    assert sampler.decoder_backend == DECODER_BACKEND_OPENCV
    assert sampler.decoder_fallback is False


def test_frame_cache_contract_is_v5():
    assert FRAME_CACHE_SCHEMA_VERSION == 5


def test_old_frame_cache_schema_is_not_fresh(tmp_path: Path):
    video = tmp_path / "video.mp4"
    video.write_bytes(b"video")
    expected = FrameEmbeddingCache.build_metadata(
        video,
        skip_threshold=0.9,
        max_gap_sec=5.0,
        frame_step=1,
    )
    old = dict(expected)
    old["schema_version"] = 4

    assert expected["schema_version"] == 5
    assert FrameEmbeddingCache.is_metadata_fresh(old, expected) is False


def test_decoder_backend_counters_are_recorded_once_per_sample(monkeypatch, tmp_path: Path):
    video = tmp_path / "video.mp4"
    video.touch()
    metrics = RecognitionMetrics()
    sampler = DynamicFrameSampler(cache_dir=tmp_path, metrics=metrics)

    def opencv(_path, _progress=None, retained_frames=None, retained_callback=None):
        sampler.retained_count = 1
        return retained_frames or []

    monkeypatch.setattr(sampler, "_sample_with_opencv", opencv)
    sampler.sample(video)

    assert metrics.counters["decoder_opencv_videos"] == 1
    assert metrics.counters["decoder_decord_videos"] == 0
    assert metrics.counters["decoder_fallbacks"] == 0

    def fail_opencv(*_args, **_kwargs):
        raise RuntimeError("opencv unavailable")

    def decord(_path, _progress=None, retained_frames=None, retained_callback=None):
        sampler.retained_count = 1
        return retained_frames or []

    monkeypatch.setattr(sampler, "_sample_with_opencv", fail_opencv)
    monkeypatch.setattr(sampler, "_sample_with_decord", decord)
    sampler.sample(video)

    assert metrics.counters["decoder_opencv_videos"] == 1
    assert metrics.counters["decoder_decord_videos"] == 1
    assert metrics.counters["decoder_fallbacks"] == 1
