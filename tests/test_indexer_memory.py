from pathlib import Path

import numpy as np

import video_sim.indexer as indexer_module
from video_sim.embedder import FrameEmbeddingCache


def _cache(values: np.ndarray) -> FrameEmbeddingCache:
    return FrameEmbeddingCache(
        video_path=str(Path("video.mp4")),
        frame_indices=np.arange(len(values), dtype=np.int64),
        timestamps=np.arange(len(values), dtype="float32"),
        phashes=["p0"] * len(values),
        thumbnail_paths=[],
        embeddings=values,
    )


def test_normalized_contiguous_float32_avoids_python_copy(monkeypatch):
    values = np.eye(4, dtype="float32")
    captured = {}

    class FakeIndex:
        d = 4
        ntotal = 0

        def add(self, embeddings):
            captured["array"] = embeddings
            self.ntotal = len(embeddings)

    monkeypatch.setattr(indexer_module.faiss, "IndexFlatIP", lambda _dimension: FakeIndex())
    result = indexer_module.build_frame_index(_cache(values))
    assert captured["array"] is values
    assert result.num_frames == 4


def test_legacy_non_normalized_dtype_gets_isolated_normalized_copy(monkeypatch):
    values = np.full((4, 4), 2.0, dtype="float64")
    captured = {}

    class FakeIndex:
        d = 4
        ntotal = 0

        def add(self, embeddings):
            captured["array"] = embeddings
            self.ntotal = len(embeddings)

    monkeypatch.setattr(indexer_module.faiss, "IndexFlatIP", lambda _dimension: FakeIndex())
    indexer_module.build_frame_index(_cache(values))
    assert captured["array"] is not values
    assert captured["array"].dtype == np.dtype("float32")
    assert np.allclose(np.linalg.norm(captured["array"], axis=1), 1.0)
    assert np.all(values == 2.0)

