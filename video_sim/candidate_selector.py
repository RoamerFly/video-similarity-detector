"""Fast coarse candidate selection for large batch comparisons."""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from pathlib import Path
from typing import Callable, Mapping

import faiss
import numpy as np

from video_sim.embedder import FrameEmbeddingCache


@dataclass(frozen=True)
class CandidateSelection:
    pairs: list[tuple[Path, Path]]
    all_pair_count: int
    candidate_limit: int

    @property
    def skipped_pair_count(self) -> int:
        return max(0, self.all_pair_count - len(self.pairs))


def select_candidate_pairs(
    video_caches: Mapping[Path, FrameEmbeddingCache],
    candidate_limit: int,
    match_threshold: float,
    representatives_per_video: int = 64,
    max_index_frames_per_video: int = 2048,
    window_seconds: float = 30.0,
    max_windows_per_video: int = 96,
    progress_callback: Callable[[int, int, str], None] | None = None,
) -> CandidateSelection:
    """
    Select likely related video pairs before the expensive frame-to-frame pass.

    Each video contributes a small, evenly distributed set of cached CLIP
    embeddings to one global FAISS index. Every video's representatives query
    that index, then retain its highest-scoring target videos. Pair selection is
    symmetric: a pair is kept when either side selects the other.
    """
    videos = list(video_caches.keys())
    all_pairs = list(combinations(videos, 2))
    all_pair_count = len(all_pairs)
    limit = max(0, int(candidate_limit))

    if len(videos) < 2 or limit == 0 or limit >= len(videos) - 1:
        if progress_callback:
            progress_callback(len(videos), max(1, len(videos)), "全部视频对")
        return CandidateSelection(all_pairs, all_pair_count, limit)

    index_blocks = []
    owner_blocks = []
    source_representatives: list[np.ndarray] = []

    for video_id, video_path in enumerate(videos):
        embeddings = np.asarray(video_caches[video_path].embeddings, dtype="float32")
        representatives = _representative_embeddings(
            embeddings,
            max(4, representatives_per_video),
        )
        window_representatives = _window_embeddings(
            embeddings,
            np.asarray(video_caches[video_path].timestamps, dtype="float32"),
            window_seconds=window_seconds,
            limit=max(1, max_windows_per_video),
        )
        source_representatives.append(_stack_nonempty([representatives, window_representatives]))
        indexed_embeddings = _representative_embeddings(
            embeddings,
            max(representatives_per_video, max_index_frames_per_video),
        )
        indexed_embeddings = _stack_nonempty([indexed_embeddings, window_representatives])
        index_blocks.append(indexed_embeddings)
        owner_blocks.append(np.full(len(indexed_embeddings), video_id, dtype=np.int32))
        if progress_callback:
            progress_callback(video_id + 1, len(videos) * 2, f"读取缓存：{video_path.name}")

    if not index_blocks or any(len(block) == 0 for block in index_blocks):
        return CandidateSelection(all_pairs, all_pair_count, limit)

    global_embeddings = np.ascontiguousarray(np.vstack(index_blocks), dtype="float32")
    global_owners = np.concatenate(owner_blocks)
    faiss.normalize_L2(global_embeddings)
    index = _build_global_index(global_embeddings.shape[1], len(global_embeddings))
    index.add(global_embeddings)

    selected_pair_ids: set[tuple[int, int]] = set()
    coarse_threshold = max(0.35, min(0.90, float(match_threshold) - 0.16))
    search_k = min(index.ntotal, max(128, limit * 16))
    if hasattr(index, "hnsw"):
        index.hnsw.efSearch = max(64, search_k)

    for source_id, query_embeddings in enumerate(source_representatives):
        query = np.ascontiguousarray(query_embeddings.copy(), dtype="float32")
        faiss.normalize_L2(query)
        similarities, indices = index.search(query, search_k)
        target_best_by_query: dict[int, np.ndarray] = {}

        for query_id, (query_similarities, query_indices) in enumerate(zip(similarities, indices)):
            for similarity, global_index in zip(query_similarities, query_indices):
                if global_index < 0:
                    continue
                target_id = int(global_owners[int(global_index)])
                if target_id == source_id:
                    continue
                target_scores = target_best_by_query.setdefault(
                    target_id,
                    np.zeros(len(query), dtype="float32"),
                )
                if similarity > target_scores[query_id]:
                    target_scores[query_id] = float(similarity)

        ranked_targets = sorted(
            (
                (_candidate_score(scores, coarse_threshold, match_threshold), target_id)
                for target_id, scores in target_best_by_query.items()
            ),
            key=lambda item: (-item[0], item[1]),
        )

        for _, target_id in ranked_targets[:limit]:
            selected_pair_ids.add(tuple(sorted((source_id, target_id))))

        if progress_callback:
            progress_callback(
                len(videos) + source_id + 1,
                len(videos) * 2,
                f"{videos[source_id].name}: {min(limit, len(ranked_targets))} 个候选",
            )

    selected_pairs = [
        (videos[left_id], videos[right_id])
        for left_id, right_id in sorted(selected_pair_ids)
    ]
    return CandidateSelection(selected_pairs, all_pair_count, limit)


def _representative_embeddings(embeddings: np.ndarray, limit: int) -> np.ndarray:
    if embeddings.ndim != 2 or len(embeddings) == 0:
        return np.zeros((0, 0), dtype="float32")
    count = min(max(1, int(limit)), len(embeddings))
    indices = np.linspace(0, len(embeddings) - 1, count, dtype=np.int64)
    return np.ascontiguousarray(embeddings[indices], dtype="float32")


def _window_embeddings(
    embeddings: np.ndarray,
    timestamps: np.ndarray,
    window_seconds: float,
    limit: int,
) -> np.ndarray:
    if embeddings.ndim != 2 or len(embeddings) == 0:
        return np.zeros((0, 0), dtype="float32")
    if len(timestamps) != len(embeddings):
        return _representative_embeddings(embeddings, limit)

    span = max(float(window_seconds), 1.0)
    buckets: dict[int, list[int]] = {}
    for index, timestamp in enumerate(timestamps):
        try:
            bucket = int(max(0.0, float(timestamp)) // span)
        except (TypeError, ValueError):
            bucket = index
        buckets.setdefault(bucket, []).append(index)

    pooled = []
    for indices in buckets.values():
        block = np.asarray(embeddings[indices], dtype="float32")
        if len(block) == 0:
            continue
        vector = np.mean(block, axis=0)
        norm = float(np.linalg.norm(vector))
        if norm > 0:
            vector = vector / norm
        pooled.append(vector.astype("float32"))

    if not pooled:
        return _representative_embeddings(embeddings, limit)
    windows = np.ascontiguousarray(np.vstack(pooled), dtype="float32")
    return _representative_embeddings(windows, limit)


def _stack_nonempty(blocks: list[np.ndarray]) -> np.ndarray:
    valid = [block for block in blocks if block.ndim == 2 and len(block) > 0]
    if not valid:
        return np.zeros((0, 0), dtype="float32")
    return np.ascontiguousarray(np.vstack(valid), dtype="float32")


def _candidate_score(
    scores: np.ndarray,
    coarse_threshold: float,
    match_threshold: float,
) -> float:
    if len(scores) == 0:
        return 0.0
    ordered = np.sort(scores)[::-1]
    top_count = max(1, len(ordered) // 4)
    coarse_coverage = float(np.count_nonzero(scores >= coarse_threshold)) / len(scores)
    strong_coverage = float(np.count_nonzero(scores >= match_threshold)) / len(scores)
    top_mean = float(np.mean(ordered[:top_count]))
    peak = float(ordered[0])
    return strong_coverage * 2.0 + coarse_coverage * 1.25 + top_mean + peak * 0.25


def _build_global_index(dimension: int, vector_count: int) -> faiss.Index:
    if vector_count < 4096:
        return faiss.IndexFlatIP(dimension)

    index = faiss.IndexHNSWFlat(dimension, 32, faiss.METRIC_INNER_PRODUCT)
    index.hnsw.efConstruction = 80
    return index
