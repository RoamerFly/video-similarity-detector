"""Low overhead, aggregate sampler telemetry tests."""

from pathlib import Path

import numpy as np
import pytest

import video_sim.frame_sampler as frame_sampler_module
from video_sim.frame_sampler import DynamicFrameSampler
from video_sim.metrics import RecognitionMetrics


class _FakeND:
    def __init__(self, value):
        self.value = value

    def asnumpy(self):
        return self.value


class _FakeVideoReader:
    frames = []

    def __init__(self, path, ctx=None, num_threads=None):
        self.path = path

    def __len__(self):
        return len(self.frames)

    def get_avg_fps(self):
        return 10.0

    def __getitem__(self, index):
        return _FakeND(self.frames[index])

    def get_batch(self, indexes):
        return _FakeND(np.stack([self.frames[index] for index in indexes]))


def _frames(count=4):
    result = []
    for index in range(count):
        frame = np.zeros((9, 13, 3), dtype=np.uint8)
        frame[:, :, 0] = index * 31
        frame[index % 9, :, 1] = 255
        result.append(frame)
    return result


@pytest.fixture
def fake_reader(monkeypatch):
    _FakeVideoReader.frames = _frames()
    monkeypatch.setattr(frame_sampler_module, "VideoReader", _FakeVideoReader)


def test_sampler_stage_metrics_flush_once_per_video_and_accumulate(fake_reader, tmp_path):
    metrics = RecognitionMetrics()
    snapshots = []
    metrics.snapshot_resources = lambda: snapshots.append(1)
    sampler = DynamicFrameSampler(
        cache_dir=tmp_path,
        metrics=metrics,
        skip_threshold=1.1,
        max_gap_sec=100.0,
    )
    first = tmp_path / "one.mp4"
    second = tmp_path / "two.mp4"
    first.touch()
    second.touch()

    sampler.sample(first)
    sampler.sample(second)

    stage_names = {
        "sampler_decode",
        "sampler_color_convert",
        "sampler_geometry",
        "sampler_hash_resize",
        "sampler_phash",
        "sampler_clip_prepare",
        "sampler_callback",
    }
    assert stage_names <= set(metrics.stages)
    assert all(metrics.stages[name].calls == 2 for name in stage_names)
    assert metrics.counters["sampled_frames"] == 8
    assert metrics.counters["retained_frames"] == 8
    assert metrics.stages["sampler_geometry"].items == 8
    assert metrics.stages["sampler_clip_prepare"].items == 8
    assert metrics.stages["preprocess"].calls == 2
    # All eight stage records are committed as one batch per sampling
    # boundary, rather than snapshotting once per stage or candidate. The
    # initial constructor snapshot is not counted.
    assert len(snapshots) == 2


def test_callback_time_and_metrics_flush_on_callback_exception(fake_reader, tmp_path):
    metrics = RecognitionMetrics()
    sampler = DynamicFrameSampler(
        cache_dir=tmp_path,
        metrics=metrics,
        skip_threshold=1.1,
        max_gap_sec=100.0,
    )
    video = tmp_path / "callback.mp4"
    video.touch()

    def fail(_frame):
        raise RuntimeError("callback failed")

    with pytest.raises(RuntimeError, match="callback failed"):
        sampler.sample_stream(video, fail)

    assert metrics.counters["sampled_frames"] == 1
    assert metrics.counters["retained_frames"] == 1
    assert metrics.stages["sampler_callback"].items == 1
    assert metrics.stages["sampler_callback"].calls == 1
    assert metrics.stages["sampler_geometry"].items == 1


def test_skip_and_decoder_fallback_keep_aggregate_counts(monkeypatch, tmp_path):
    metrics = RecognitionMetrics()
    sampler = DynamicFrameSampler(
        cache_dir=tmp_path,
        metrics=metrics,
        skip_threshold=0.0,
        max_gap_sec=100.0,
    )
    video = tmp_path / "fallback.mp4"
    video.touch()
    frame = np.full((9, 13, 3), 127, dtype=np.uint8)

    def fail_decord(*_args, **_kwargs):
        raise RuntimeError("decord unavailable")

    def fallback_opencv(_path, _progress=None, retained_frames=None, retained_callback=None):
        sampler.total_frames = 2
        sampler.source_duration_sec = 0.2
        last_hash = None
        last_index = -1
        for index in range(2):
            last_hash, last_index = sampler._consider_frame(
                frame=frame,
                frame_index=index,
                timestamp=index / 10.0,
                retained_frames=retained_frames,
                last_retained_hash=last_hash,
                last_retained_index=last_index,
                max_gap_frames=100,
                video_path=_path,
                retained_callback=retained_callback,
            )
        return retained_frames or []

    monkeypatch.setattr(sampler, "_sample_with_decord", fail_decord)
    monkeypatch.setattr(sampler, "_sample_with_opencv", fallback_opencv)
    retained = sampler.sample(video)

    assert len(retained) == 1
    assert metrics.counters["sampled_frames"] == 2
    assert metrics.counters["retained_frames"] == 1
    assert metrics.stages["sampler_phash"].items == 2
    assert metrics.stages["sampler_clip_prepare"].items == 1
    assert metrics.stages["preprocess"].items == 3


def test_metrics_none_keeps_sampling_telemetry_disabled(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(frame_sampler_module.time, "perf_counter", lambda: calls.append(1) or 0.0)
    sampler = DynamicFrameSampler(cache_dir=tmp_path, metrics=None)
    retained = []
    sampler._consider_frame(
        frame=np.zeros((9, 13, 3), dtype=np.uint8),
        frame_index=0,
        timestamp=0.0,
        retained_frames=retained,
        last_retained_hash=None,
        last_retained_index=-1,
        max_gap_frames=100,
        video_path=Path("none.mp4"),
    )
    assert retained
    assert calls == []
