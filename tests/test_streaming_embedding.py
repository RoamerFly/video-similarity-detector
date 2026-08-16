from pathlib import Path
import threading

import numpy as np
import pytest

from video_sim.embedder import embed_frames_with_cache
from video_sim.frame_sampler import DynamicFrameSampler, RetainedFrame
from video_sim.metrics import RecognitionMetrics
from video_sim.preprocess import PreprocessConfig


class _FakeSampler:
    def __init__(self, frames, *, fail=None):
        self.frames = list(frames)
        self.source_duration_sec = float(len(self.frames))
        self.fail = fail
        self.callback_threads = []

    def sample(self, _video_path, progress_callback=None):
        if progress_callback:
            progress_callback(len(self.frames), len(self.frames), self.source_duration_sec)
        return list(self.frames)

    def sample_stream(self, _video_path, retained_callback, progress_callback=None):
        for index, frame in enumerate(self.frames):
            self.callback_threads.append(threading.current_thread().name)
            retained_callback(frame)
            if progress_callback:
                progress_callback(index + 1, len(self.frames), frame.timestamp)
        if self.fail is not None:
            raise self.fail
        return len(self.frames)


class _RaisingSampler(_FakeSampler):
    def sample_stream(self, *_args, **_kwargs):
        raise AssertionError("cache hit must not start sampling")


class _FakeEmbedder:
    def __init__(self, device="cpu", metrics=None, fail=False):
        self.device = device
        self.metrics = metrics
        self.fail = fail
        self.batches = []

    def embedding_runtime_fingerprint(self):
        return "precision=fp32"

    def embed_frames_batch(self, frames, *, batch_size, progress_callback, frames_are_preprocessed):
        assert frames_are_preprocessed is True
        assert progress_callback is None
        if self.fail:
            raise RuntimeError("consumer failed")
        self.batches.append(np.asarray(frames).copy())
        values = np.asarray(frames[:, 0, 0, 0], dtype=np.float32)
        return np.repeat(values[:, None], 4, axis=1)


def _frames(count=5):
    return [
        RetainedFrame(
            video_path="sample.mp4",
            frame_index=index,
            timestamp=index / 10.0,
            phash=f"p{index}",
            clip_frame=np.full((2, 2, 3), index + 1, dtype=np.uint8),
        )
        for index in range(count)
    ]


def _run(tmp_path: Path, *, device="cpu", sampler=None, embedder=None, streaming=True, force=True):
    tmp_path.mkdir(parents=True, exist_ok=True)
    video = tmp_path / "sample.mp4"
    if not video.exists():
        video.write_bytes(b"sample")
    config = PreprocessConfig(input_size=2)
    return embed_frames_with_cache(
        video_path=video,
        retained_frames=None if streaming else sampler.frames,
        sampler=sampler if streaming else None,
        embedder=embedder,
        cache_dir=tmp_path / "data",
        device=device,
        force=force,
        preprocess_config=config,
        skip_threshold=0.9,
        max_gap_sec=2.0,
        frame_step=1,
        embedding_runtime="precision=fp32",
        streaming=streaming,
        source_duration_sec=sampler.source_duration_sec if not streaming else None,
    )


def test_streaming_cache_matches_materialized_path(tmp_path, monkeypatch):
    monkeypatch.setenv("VIDEO_SIM_EMBED_BATCH_SIZE", "2")
    frames = _frames()
    legacy = _run(
        tmp_path / "legacy",
        sampler=_FakeSampler(frames),
        embedder=_FakeEmbedder(),
        streaming=False,
    )
    metrics = RecognitionMetrics()
    streamed_embedder = _FakeEmbedder(metrics=metrics)
    streamed = _run(
        tmp_path / "streamed",
        sampler=_FakeSampler(frames),
        embedder=streamed_embedder,
        streaming=True,
    )

    assert np.array_equal(streamed.frame_indices, legacy.frame_indices)
    assert np.array_equal(streamed.timestamps, legacy.timestamps)
    assert streamed.phashes == legacy.phashes
    assert np.allclose(streamed.embeddings, legacy.embeddings)
    assert metrics.counters["streaming_batches"] == 3
    assert metrics.counters["prepared_frames_released"] == len(frames)
    assert metrics.counters["queue_peak_frames"] == 2


def test_cache_hit_does_not_create_embedder_or_start_sampler(tmp_path):
    frames = _frames(2)
    _run(tmp_path, sampler=_FakeSampler(frames), embedder=_FakeEmbedder(), streaming=True)
    cache = _run(
        tmp_path,
        sampler=_RaisingSampler(frames),
        embedder=None,
        streaming=True,
        force=False,
    )
    assert cache.metadata["embedding_runtime"] == "precision=fp32"


def test_cuda_streaming_queue_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setenv("VIDEO_SIM_EMBED_BATCH_SIZE", "2")
    monkeypatch.setenv("VIDEO_SIM_STREAMING_QUEUE_SIZE", "2")
    metrics = RecognitionMetrics()
    embedder = _FakeEmbedder(device="cuda", metrics=metrics)
    sampler = _FakeSampler(_frames(12))
    _run(
        tmp_path,
        device="cuda",
        sampler=sampler,
        embedder=embedder,
        streaming=True,
    )
    frame_bytes = 2 * 2 * 3
    assert metrics.counters["queue_peak_frames"] <= 4  # two batches of two frames
    assert metrics.counters["queue_peak_bytes"] <= 4 * frame_bytes
    assert sampler.callback_threads
    assert all(name == "video-sim-frame-producer" for name in sampler.callback_threads)


def test_streaming_producer_error_propagates_and_thread_exits(tmp_path):
    sampler = _FakeSampler(_frames(4), fail=ValueError("producer failed"))
    with pytest.raises(ValueError, match="producer failed"):
        _run(
            tmp_path,
            device="cuda",
            sampler=sampler,
            embedder=_FakeEmbedder(device="cuda"),
            streaming=True,
        )
    assert not [thread for thread in threading.enumerate() if thread.name == "video-sim-frame-producer"]


def test_streaming_consumer_error_stops_producer(tmp_path):
    with pytest.raises(RuntimeError, match="consumer failed"):
        _run(
            tmp_path,
            device="cuda",
            sampler=_FakeSampler(_frames(50)),
            embedder=_FakeEmbedder(device="cuda", fail=True),
            streaming=True,
        )
    assert not [thread for thread in threading.enumerate() if thread.name == "video-sim-frame-producer"]


def test_streaming_cancel_exits_without_deadlock(tmp_path):
    cancel_event = threading.Event()
    cancel_event.set()
    video = tmp_path / "cancel.mp4"
    video.write_bytes(b"cancel")
    with pytest.raises(RuntimeError, match="cancelled"):
        embed_frames_with_cache(
            video_path=video,
            retained_frames=None,
            sampler=_FakeSampler(_frames(50)),
            embedder=_FakeEmbedder(device="cuda"),
            cache_dir=tmp_path / "data",
            device="cuda",
            force=True,
            preprocess_config=PreprocessConfig(input_size=2),
            embedding_runtime="precision=fp32",
            streaming=True,
            cancel_event=cancel_event,
        )
    assert not [thread for thread in threading.enumerate() if thread.name == "video-sim-frame-producer"]


def test_empty_stream_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="No retained frames"):
        _run(
            tmp_path,
            sampler=_FakeSampler([]),
            embedder=_FakeEmbedder(),
            streaming=True,
        )


def test_dynamic_sampler_stream_api_preserves_order(monkeypatch, tmp_path):
    video = tmp_path / "sample.mp4"
    video.write_bytes(b"sample")
    sampler = DynamicFrameSampler(cache_dir=tmp_path)
    frames = _frames(4)

    def fake_decode(_path, _progress=None, retained_frames=None, retained_callback=None):
        sampler.total_frames = len(frames)
        sampler.source_duration_sec = 1.0
        for frame in frames:
            if retained_frames is not None:
                retained_frames.append(frame)
            sampler.retained_count += 1
            if retained_callback is not None:
                retained_callback(frame)
        return retained_frames or []

    monkeypatch.setattr(sampler, "_sample_with_decord", fake_decode)
    materialized = sampler.sample(video)
    streamed = []
    sampler.sample_stream(video, streamed.append)

    assert [frame.frame_index for frame in streamed] == [frame.frame_index for frame in materialized]
    assert [frame.timestamp for frame in streamed] == [frame.timestamp for frame in materialized]


def test_sampler_does_not_restart_after_decoder_emitted_frame(monkeypatch, tmp_path):
    """A partial stream failure must propagate instead of duplicating output."""
    video = tmp_path / "partial.mp4"
    video.write_bytes(b"partial")
    sampler = DynamicFrameSampler(cache_dir=tmp_path)
    frame = _frames(1)[0]
    fallback_called = False

    def decord(_path, _progress=None, retained_frames=None, retained_callback=None):
        sampler.retained_count = 1
        sampler._retained_callback_failed = True
        if retained_callback is not None:
            retained_callback(frame)
        raise RuntimeError("decoder failed after first frame")

    def opencv(*_args, **_kwargs):
        nonlocal fallback_called
        fallback_called = True
        return []

    monkeypatch.setattr(sampler, "_sample_with_decord", decord)
    monkeypatch.setattr(sampler, "_sample_with_opencv", opencv)
    with pytest.raises(RuntimeError, match="after first frame"):
        sampler.sample_stream(video, lambda _frame: None)
    assert not fallback_called


def test_sampler_falls_back_when_decoder_fails_before_first_frame(monkeypatch, tmp_path):
    video = tmp_path / "fallback.mp4"
    video.write_bytes(b"fallback")
    sampler = DynamicFrameSampler(cache_dir=tmp_path)
    frame = _frames(1)[0]
    fallback_called = False
    decoder_calls = 0

    def decord(*_args, **_kwargs):
        nonlocal decoder_calls
        decoder_calls += 1
        if decoder_calls == 1:
            sampler.retained_count = 1
            sampler._retained_callback_failed = True
            callback = _args[-1] if _args and callable(_args[-1]) else None
            if callback is not None:
                callback(frame)
            raise RuntimeError("decoder failed after first frame")
        raise RuntimeError("decoder failed before first frame")

    def opencv(_path, _progress=None, retained_frames=None, retained_callback=None):
        nonlocal fallback_called
        fallback_called = True
        sampler.retained_count = 1
        if retained_callback is not None:
            retained_callback(frame)
        return [frame]

    monkeypatch.setattr(sampler, "_sample_with_decord", decord)
    monkeypatch.setattr(sampler, "_sample_with_opencv", opencv)
    with pytest.raises(RuntimeError, match="after first frame"):
        sampler.sample_stream(video, lambda _frame: None)
    emitted = []
    sampler.sample_stream(video, emitted.append)
    assert fallback_called
    assert [item.frame_index for item in emitted] == [frame.frame_index]
