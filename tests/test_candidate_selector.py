from pathlib import Path

import numpy as np
import pytest

import video_sim.candidate_selector as candidate_selector
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


def test_candidate_selection_does_not_materialize_all_pairs(
    tmp_path: Path,
    monkeypatch,
) -> None:
    timestamps = np.array([0, 5, 10], dtype="float32")
    caches = {
        tmp_path / f"{index}.mp4": _cache(
            tmp_path / f"{index}.mp4",
            np.tile([[1.0, float(index), 0.0, 0.0]], (3, 1)),
            timestamps,
        )
        for index in range(4)
    }

    def fail_if_materialized(*_args, **_kwargs):
        raise AssertionError("all video pairs were materialized before candidate screening")

    monkeypatch.setattr(candidate_selector, "combinations", fail_if_materialized)
    selection = select_candidate_pairs(
        caches,
        candidate_limit=1,
        match_threshold=0.8,
        representatives_per_video=1,
        max_index_frames_per_video=1,
    )

    assert selection.all_pair_count == 6
    assert len(selection.pairs) <= 4


def test_candidate_selection_rejects_empty_embedding_cache(tmp_path: Path) -> None:
    valid_path = tmp_path / "valid.mp4"
    other_path = tmp_path / "other.mp4"
    empty_path = tmp_path / "empty.mp4"
    valid_cache = _cache(
        valid_path,
        np.array([[1.0, 0.0], [1.0, 0.0]], dtype="float32"),
        np.array([0, 1], dtype="float32"),
    )
    empty_cache = FrameEmbeddingCache(
        video_path=str(empty_path),
        frame_indices=np.array([], dtype=np.int64),
        timestamps=np.array([], dtype="float32"),
        phashes=[],
        thumbnail_paths=[],
        embeddings=np.zeros((0, 2), dtype="float32"),
    )

    with pytest.raises(ValueError, match="empty.mp4"):
        select_candidate_pairs(
            {
                valid_path: valid_cache,
                other_path: _cache(
                    other_path,
                    np.array([[0.0, 1.0], [0.0, 1.0]], dtype="float32"),
                    np.array([0, 1], dtype="float32"),
                ),
                empty_path: empty_cache,
            },
            candidate_limit=1,
            match_threshold=0.8,
        )
