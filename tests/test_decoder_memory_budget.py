import numpy as np

from video_sim.frame_sampler import (
    DEFAULT_DECODE_BATCH_BYTES,
    DynamicFrameSampler,
    decode_batch_size_for_frame_shape,
    parse_decode_batch_bytes,
)


class _FakeNDArray:
    def __init__(self, value):
        self.value = np.asarray(value)

    def asnumpy(self):
        return self.value


class _FakeVideoReader:
    def __init__(self, frame_count=10, frame_shape=(2, 3, 3), fail_batches=False):
        self.frames = [
            np.full(frame_shape, index, dtype=np.uint8)
            for index in range(frame_count)
        ]
        self.fail_batches = fail_batches
        self.batch_calls = []
        self.single_calls = []

    def __getitem__(self, index):
        self.single_calls.append(index)
        return _FakeNDArray(self.frames[index])

    def get_batch(self, indices):
        indices = list(indices)
        self.batch_calls.append(indices)
        if self.fail_batches:
            raise RuntimeError("batch decode failed")
        return _FakeNDArray(np.stack([self.frames[index] for index in indices]))


class _ProbeFailVideoReader(_FakeVideoReader):
    def __getitem__(self, index):
        if index == 0:
            raise RuntimeError("geometry probe failed")
        return super().__getitem__(index)


def test_decode_batch_bytes_default_and_invalid_values(monkeypatch):
    monkeypatch.delenv("VIDEO_SIM_DECODE_BATCH_BYTES", raising=False)
    assert parse_decode_batch_bytes() == DEFAULT_DECODE_BATCH_BYTES
    assert parse_decode_batch_bytes("4096") == 4096
    assert parse_decode_batch_bytes("not-a-size") == DEFAULT_DECODE_BATCH_BYTES
    assert parse_decode_batch_bytes("0") == DEFAULT_DECODE_BATCH_BYTES
    assert parse_decode_batch_bytes("-1") == DEFAULT_DECODE_BATCH_BYTES


def test_decode_batch_size_respects_1080p_and_4k_byte_budget():
    budget = 64 * 1024 * 1024
    # Decord returns RGB uint8 frames, so these are approximately 5.93 MiB
    # and 23.73 MiB per frame respectively.
    assert decode_batch_size_for_frame_shape((1080, 1920, 3), budget) == 10
    assert decode_batch_size_for_frame_shape((2160, 3840, 3), budget) == 2


def test_oversized_single_frame_uses_one_and_exposes_soft_cap_state(monkeypatch):
    budget = 1024
    assert decode_batch_size_for_frame_shape((100, 100, 3), budget) == 1

    # A single decoded frame can exceed the requested batch budget. The
    # implementation records that condition; it cannot promise a strict
    # process RSS bound because the decoder owns additional buffers.
    monkeypatch.setenv("VIDEO_SIM_DECODE_BATCH_BYTES", str(budget))
    reader = _FakeVideoReader(frame_count=2, frame_shape=(100, 100, 3))
    sampler = DynamicFrameSampler(cache_dir=".")
    list(sampler._iter_decord_bgr_frames(reader, total_frames=2))
    assert sampler.last_decode_batch_size == 1
    assert sampler.last_decode_batch_oversized is True


def test_decord_batches_follow_frame_step_and_preserve_order(monkeypatch, tmp_path):
    reader = _FakeVideoReader(frame_count=13)
    sampler = DynamicFrameSampler(cache_dir=tmp_path, frame_step=3)
    monkeypatch.setattr(
        "video_sim.frame_sampler.parse_decode_batch_bytes",
        lambda: 3 * 3 * 2 * 2,
    )

    decoded = list(sampler._iter_decord_bgr_frames(reader, total_frames=13))

    assert [index for index, _ in decoded] == [0, 3, 6, 9, 12]
    assert [len(indices) for indices in reader.batch_calls] == [1, 2, 1]
    assert all(0 not in indices for indices in reader.batch_calls)
    assert sampler.last_decode_batch_size == 2


def test_prefetched_only_first_chunk_does_not_call_empty_batch(tmp_path):
    reader = _FakeVideoReader(frame_count=1)
    sampler = DynamicFrameSampler(cache_dir=tmp_path)

    decoded = list(sampler._iter_decord_bgr_frames(reader, total_frames=1))

    assert [index for index, _ in decoded] == [0]
    assert reader.batch_calls == []


def test_get_batch_failure_falls_back_to_single_frames_in_order(monkeypatch, tmp_path):
    reader = _FakeVideoReader(frame_count=8, fail_batches=True)
    sampler = DynamicFrameSampler(cache_dir=tmp_path, frame_step=2)
    monkeypatch.setattr(
        "video_sim.frame_sampler.parse_decode_batch_bytes",
        lambda: 1024,
    )

    decoded = list(sampler._iter_decord_bgr_frames(reader, total_frames=8))

    assert [index for index, _ in decoded] == [0, 2, 4, 6]
    assert reader.batch_calls
    # The first scalar access is the geometry probe; the remaining accesses
    # are the ordered per-frame fallback after each failed batch request.
    assert reader.single_calls == [0, 2, 4, 6]


def test_probe_failure_keeps_full_batch_fallback_order(monkeypatch, tmp_path):
    reader = _ProbeFailVideoReader(frame_count=8)
    sampler = DynamicFrameSampler(cache_dir=tmp_path, frame_step=2)
    monkeypatch.setattr(
        "video_sim.frame_sampler.parse_decode_batch_bytes",
        lambda: 1024,
    )

    decoded = list(sampler._iter_decord_bgr_frames(reader, total_frames=8))

    assert [index for index, _ in decoded] == [0, 2, 4, 6]
    assert reader.batch_calls == [[0], [2], [4], [6]]
