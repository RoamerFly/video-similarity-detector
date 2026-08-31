from pathlib import Path

import numpy as np

from video_sim.candidate_selector import (
    _auxiliary_candidate_scores,
    _build_auxiliary_signature_index,
    _multiscale_sketch,
    _temporal_auxiliary_score,
    build_candidate_summary,
    select_candidate_pairs,
)
from video_sim.embedder import FrameEmbeddingCache
from video_sim.indexer import calculate_faiss_thread_budget, configure_faiss_thread_budget


def _cache(path: Path, values: np.ndarray) -> FrameEmbeddingCache:
    values = np.asarray(values, dtype="float32")
    values /= np.where(np.linalg.norm(values, axis=1, keepdims=True) == 0, 1.0, np.linalg.norm(values, axis=1, keepdims=True))
    return FrameEmbeddingCache(
        video_path=str(path),
        frame_indices=np.arange(len(values), dtype=np.int64),
        timestamps=np.arange(len(values), dtype="float32"),
        phashes=[f"p{index}" for index in range(len(values))],
        thumbnail_paths=[],
        embeddings=values,
    )


def test_multiscale_sketch_has_a_hard_limit_and_captures_local_middle():
    values = np.eye(4, dtype="float32")
    values = np.vstack([values[(index % 4) : (index % 4) + 1] for index in range(80)])
    sketch = _multiscale_sketch(values, np.arange(80, dtype="float32"), limit=12, window_seconds=20)
    assert len(sketch) <= 12
    assert sketch.shape[1] == values.shape[1]


def test_multiscale_sketch_round_robins_late_buckets():
    values = np.arange(120 * 2, dtype="float32").reshape(120, 2)
    sketch = _multiscale_sketch(
        values,
        np.arange(120, dtype="float32"),
        limit=12,
        window_seconds=20,
    )
    # The sixth 20-second bucket must receive a local quota even though the
    # global uniform samples are emitted first.
    assert any(np.array_equal(row, values[100]) for row in sketch)


def test_candidate_limit_zero_keeps_legacy_all_pairs_and_selection_is_deterministic(tmp_path: Path):
    caches = {
        tmp_path / f"{index}.mp4": _cache(
            tmp_path / f"{index}.mp4",
            np.eye(4, dtype="float32")[[index % 4] * 8],
        )
        for index in range(4)
    }
    all_pairs = select_candidate_pairs(caches, candidate_limit=0, match_threshold=0.8)
    first = select_candidate_pairs(caches, candidate_limit=1, match_threshold=0.8, representatives_per_video=8, max_index_frames_per_video=8)
    second = select_candidate_pairs(caches, candidate_limit=1, match_threshold=0.8, representatives_per_video=8, max_index_frames_per_video=8)
    assert len(all_pairs.pairs) == 6
    assert first.pairs == second.pairs


def test_compact_summary_preserves_legacy_candidate_selection(tmp_path: Path):
    rng = np.random.default_rng(33)
    caches = {
        tmp_path / f"{index}.mp4": _cache(
            tmp_path / f"{index}.mp4",
            rng.normal(size=(80 + index * 3, 8)).astype("float32"),
        )
        for index in range(5)
    }
    summaries = {
        path: build_candidate_summary(cache)
        for path, cache in caches.items()
    }
    legacy = select_candidate_pairs(
        caches,
        candidate_limit=2,
        match_threshold=0.8,
    )
    compact = select_candidate_pairs(
        summaries,
        candidate_limit=2,
        match_threshold=0.8,
    )
    assert compact.pairs == legacy.pairs


def test_short_middle_clip_is_recalled_without_full_frame_index(tmp_path: Path):
    rng = np.random.default_rng(17)
    shared = rng.normal(size=(4, 8)).astype("float32")
    a_values = rng.normal(size=(1000, 8)).astype("float32")
    b_values = rng.normal(size=(1000, 8)).astype("float32")
    a_values[500:504] = shared
    b_values[500:504] = shared
    a = tmp_path / "a.mp4"
    b = tmp_path / "b.mp4"
    c = tmp_path / "c.mp4"
    caches = {a: _cache(a, a_values), b: _cache(b, b_values), c: _cache(c, rng.normal(size=(1000, 8)).astype("float32"))}
    selection = select_candidate_pairs(
        caches,
        candidate_limit=1,
        match_threshold=0.8,
        representatives_per_video=64,
        max_index_frames_per_video=64,
        window_seconds=100,
        max_windows_per_video=16,
    )
    assert (a, b) in selection.pairs or (b, a) in selection.pairs


def test_continuous_evidence_requires_source_and_target_time_order():
    source_times = np.arange(8, dtype="float32")
    coherent_target_times = np.arange(100, 108, dtype="float32")
    shuffled_target_times = np.array([100, 104, 101, 107, 102, 106, 103, 105], dtype="float32")
    evidence = {(index, index) for index in range(8)}
    coherent_score = _temporal_auxiliary_score(
        evidence, source_times, coherent_target_times
    )
    shuffled_score = _temporal_auxiliary_score(
        evidence, source_times, shuffled_target_times
    )
    assert coherent_score > shuffled_score


def test_auxiliary_channels_and_hamming_filter_are_enforced(tmp_path: Path):
    zeros = np.ones((4, 4), dtype="float32")
    phash_a = FrameEmbeddingCache(
        video_path=str(tmp_path / "a.mp4"),
        frame_indices=np.arange(4),
        timestamps=np.arange(4, dtype="float32"),
        phashes=["0000000000000000"] * 4,
        thumbnail_paths=[],
        embeddings=zeros,
    )
    # The low band collides, but the full signatures differ by 16 bits and
    # must therefore be rejected by the post-LSH Hamming check.
    phash_b = FrameEmbeddingCache(
        video_path=str(tmp_path / "b.mp4"),
        frame_indices=np.arange(4),
        timestamps=np.arange(4, dtype="float32"),
        phashes=["000000000000ffff"] * 4,
        thumbnail_paths=[],
        embeddings=zeros,
    )
    simhash_c = _cache(tmp_path / "c.mp4", zeros)
    index = _build_auxiliary_signature_index([phash_a, phash_b, simhash_c])
    assert index.signature_kinds == ["phash", "phash", "simhash"]
    assert _auxiliary_candidate_scores(0, index, [phash_a, phash_b, simhash_c]) == {}


def test_auxiliary_bucket_collision_keeps_one_entry_per_owner(tmp_path: Path):
    caches = []
    for index in range(128):
        path = tmp_path / f"owner-{index}.mp4"
        caches.append(
            FrameEmbeddingCache(
                video_path=str(path),
                frame_indices=np.arange(4),
                timestamps=np.arange(4, dtype="float32"),
                phashes=["0000000000000000"] * 4,
                thumbnail_paths=[],
                embeddings=np.ones((4, 4), dtype="float32"),
            )
        )
    index = _build_auxiliary_signature_index(caches)
    scores = _auxiliary_candidate_scores(0, index, caches)
    assert len(scores) == 127


def test_thread_budget_is_bounded_and_handles_missing_cpu_api(monkeypatch):
    assert calculate_faiss_thread_budget(1, 16) == 16
    assert calculate_faiss_thread_budget(2, 16) == 8
    assert calculate_faiss_thread_budget(8, 4) == 1
    monkeypatch.setattr("video_sim.indexer.os.cpu_count", lambda: None)
    assert calculate_faiss_thread_budget(8) == 1
    monkeypatch.setattr("video_sim.indexer.faiss", object())
    assert configure_faiss_thread_budget(2, 8) == 4


def test_thread_budget_configures_faiss_for_each_calling_thread(monkeypatch):
    import video_sim.indexer as indexer

    calls = []
    monkeypatch.setattr(indexer.faiss, "omp_set_num_threads", calls.append, raising=False)
    monkeypatch.setattr(indexer, "_LAST_FAISS_THREAD_BUDGET", None)
    assert indexer.configure_faiss_thread_budget(2, 8) == 4
    assert indexer.configure_faiss_thread_budget(2, 8) == 4
    # FAISS's OpenMP setting can be thread-local in the installed runtime.
    # Reapply it for every calling thread; the coordinator must not rely on a
    # process-global last-value guard to configure a worker that has just
    # started. The call remains outside per-query loops.
    assert calls == [4, 4]
