from types import SimpleNamespace

import numpy as np
import pytest
import torch

import video_sim.embedder as embedder_module
from video_sim.embedder import VideoEmbedder
from video_sim.metrics import RecognitionMetrics
from video_sim.preprocess import PreprocessConfig


class _Inputs(dict):
    def to(self, _device):
        return self


class _Processor:
    def __init__(self):
        self.images = []

    def __call__(self, *, images, return_tensors):
        assert return_tensors == "pt"
        self.images = list(images)
        return _Inputs()


class _Model:
    def __init__(self, processor, fail_once=False):
        self.processor = processor
        self.fail_once = fail_once
        self.calls = []

    def __call__(self, **_kwargs):
        assert torch.is_inference_mode_enabled()
        batch_size = len(self.processor.images)
        self.calls.append(batch_size)
        if self.fail_once and len(self.calls) == 1:
            raise RuntimeError("CUDA out of memory")
        values = torch.arange(batch_size * 4, dtype=torch.float32).reshape(batch_size, 4) + 1
        return SimpleNamespace(pooler_output=values)


def _fake_embedder(*, device="cpu", metrics=None, fail_once=False):
    embedder = object.__new__(VideoEmbedder)
    embedder.device = device
    embedder.num_frames = 4
    embedder.preprocess_config = PreprocessConfig(input_size=2)
    embedder.autocast_enabled = False
    embedder.autocast_dtype_name = "float16"
    embedder.autocast_dtype = torch.float16
    embedder.metrics = metrics
    embedder.last_batch_sizes = []
    embedder.clip_processor = _Processor()
    embedder.clip_model = _Model(embedder.clip_processor, fail_once=fail_once)
    return embedder


def test_prepared_rgb_frames_are_not_preprocessed_twice(monkeypatch):
    calls = []

    def fail_if_called(frame, config):
        calls.append(frame)
        raise AssertionError("prepared frames must skip geometric preprocessing")

    monkeypatch.setattr(embedder_module, "preprocess_frame_for_clip", fail_if_called)
    embedder = _fake_embedder()
    prepared = np.array(
        [
            [[[10, 20, 30], [30, 20, 10]], [[1, 2, 3], [4, 5, 6]]],
            [[[7, 8, 9], [9, 8, 7]], [[11, 12, 13], [14, 15, 16]]],
        ],
        dtype=np.uint8,
    )

    result = embedder.embed_frames_batch(prepared, batch_size=2, frames_are_preprocessed=True)

    assert not calls
    assert np.array_equal(np.asarray(embedder.clip_processor.images[0]), prepared[0])
    assert result.dtype == np.float32
    assert np.allclose(np.linalg.norm(result, axis=1), 1.0)


def test_raw_frames_are_preprocessed_once(monkeypatch):
    calls = []
    original = embedder_module.preprocess_frame_for_clip

    def counted(frame, config):
        calls.append(frame.copy())
        return original(frame, config)

    monkeypatch.setattr(embedder_module, "preprocess_frame_for_clip", counted)
    embedder = _fake_embedder()
    raw = np.zeros((3, 4, 5, 3), dtype=np.uint8)
    embedder.embed_frames_batch(raw, batch_size=2)
    assert len(calls) == len(raw)


def test_cuda_oom_reduces_batch_without_empty_cache_on_success(monkeypatch):
    metrics = RecognitionMetrics()
    embedder = _fake_embedder(device="cuda", metrics=metrics, fail_once=True)
    empty_cache_calls = []
    monkeypatch.setattr(torch.cuda, "empty_cache", lambda: empty_cache_calls.append(True))
    prepared = np.zeros((5, 2, 2, 3), dtype=np.uint8)

    result = embedder.embed_frames_batch(prepared, batch_size=4, frames_are_preprocessed=True)

    assert result.shape == (5, 4)
    assert embedder.clip_model.calls == [4, 2, 2, 1]
    assert embedder.last_batch_sizes == [2, 2, 1]
    assert len(empty_cache_calls) == 1
    assert metrics.to_dict()["counters"]["embedding_oom_retries"] == 1


def test_non_oom_runtime_error_is_not_retried(monkeypatch):
    embedder = _fake_embedder(device="cuda")

    def fail(_self, **_kwargs):
        raise RuntimeError("model input is invalid")

    monkeypatch.setattr(type(embedder.clip_model), "__call__", fail)
    with pytest.raises(RuntimeError, match="model input is invalid"):
        embedder.embed_frames_batch(
            np.zeros((1, 2, 2, 3), dtype=np.uint8),
            frames_are_preprocessed=True,
        )
