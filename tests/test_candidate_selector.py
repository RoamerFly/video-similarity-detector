import sys
import types
from pathlib import Path

import numpy as np

decord_stub = types.ModuleType("decord")
decord_stub.VideoReader = object
decord_stub.cpu = lambda *_args, **_kwargs: None
sys.modules.setdefault("decord", decord_stub)

from video_sim.candidate_selector import select_candidate_pairs
from video_sim.embedder import FrameEmbeddingCache


def _normalize(values: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1.0, norms)
    return (values / norms).astype("float32")


def _cache(path: Path, embeddings: np.ndarray, timestamps: np.ndarray) -> FrameEmbeddingCache:
    return FrameEmbeddingCache(
        video_path=str(path),
        frame_indices=np.arange(len(embeddings), dtype=np.int64),
        timestamps=timestamps.astype("float32"),
        phashes=[f"p{i}" for i in range(len(embeddings))],
        thumbnail_paths=[],
        embeddings=_normalize(embeddings.astype("float32")),
    )


def test_candidate_selection_uses_window_level_similarity(tmp_path: Path) -> None:
    shared = np.tile([[1.0, 0.0, 0.0, 0.0]], (6, 1))
    unrelated = np.tile([[0.0, 1.0, 0.0, 0.0]], (6, 1))
    other = np.tile([[0.0, 0.0, 1.0, 0.0]], (6, 1))
    timestamps = np.array([0, 5, 10, 40, 45, 50], dtype="float32")

    video_a = tmp_path / "a.mp4"
    video_b = tmp_path / "b.mp4"
    video_c = tmp_path / "c.mp4"
    caches = {
        video_a: _cache(video_a, np.vstack([shared[:3], unrelated[:3]]), timestamps),
        video_b: _cache(video_b, np.vstack([shared[:3], other[:3]]), timestamps),
        video_c: _cache(video_c, np.vstack([other[:3], unrelated[:3]]), timestamps),
    }

    selection = select_candidate_pairs(
        caches,
        candidate_limit=1,
        match_threshold=0.8,
        representatives_per_video=1,
        max_index_frames_per_video=1,
        window_seconds=30,
        max_windows_per_video=4,
    )

    assert (video_a, video_b) in selection.pairs or (video_b, video_a) in selection.pairs
    assert selection.all_pair_count == 3
