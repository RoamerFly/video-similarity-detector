"""
Video matching/querying module for video similarity search.

Provides similarity search functionality using FAISS indices.
Supports both video-level search and frame-level bidirectional containment detection.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple, Union

import faiss
import numpy as np

from video_sim.config import Config
from video_sim.embedder import FrameEmbeddingCache, VideoEmbedder, get_embedder
from video_sim.frame_sampler import sample_frames
from video_sim.indexer import FrameIndexResult, build_frame_index

# Type alias for search results
SearchResult = Tuple[str, float]
TEMPORAL_OFFSET_TOLERANCE_SEC = 3.0


@dataclass
class FrameMatch:
    """
    A single frame match record between two videos.

    Attributes:
        source_video: Path to the source video
        target_video: Path to the target video
        source_frame_index: Frame index in the source video
        target_frame_index: Frame index in the target video
        source_timestamp: Timestamp in seconds in the source video
        target_timestamp: Timestamp in seconds in the target video
        similarity: Cosine similarity score (0-1)
    """

    source_video: str
    target_video: str
    source_frame_index: int
    target_frame_index: int
    source_timestamp: float
    target_timestamp: float
    similarity: float
    source_thumbnail_path: Optional[str] = None
    target_thumbnail_path: Optional[str] = None

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        data = {
            "source_video": self.source_video,
            "target_video": self.target_video,
            "source_frame_index": int(self.source_frame_index),
            "target_frame_index": int(self.target_frame_index),
            "source_timestamp": float(self.source_timestamp),
            "target_timestamp": float(self.target_timestamp),
            "similarity": float(self.similarity),
        }
        if self.source_thumbnail_path:
            data["source_thumbnail_path"] = self.source_thumbnail_path
        if self.target_thumbnail_path:
            data["target_thumbnail_path"] = self.target_thumbnail_path
        return data


@dataclass
class ContainmentResult:
    """
    Result of bidirectional containment detection between two videos.

    Attributes:
        video_a: Path to video A
        video_b: Path to video B
        a_in_b: Ratio of A frames matched in B (A's unique matched frames / A's total frames)
        b_in_a: Ratio of B frames matched in A (B's unique matched frames / B's total frames)
        symmetric_similarity: Average of a_in_b and b_in_a
        avg_similarity_a_to_b: Average best-match similarity from A to B (per source frame)
        avg_similarity_b_to_a: Average best-match similarity from B to A (per source frame)
        relation: Relationship classification
        matches_a_to_b: List of matches from A to B
        matches_b_to_a: List of matches from B to A
        total_frames_a: Total frames in video A
        total_frames_b: Total frames in video B
        duration_a: Estimated duration in seconds for video A
        duration_b: Estimated duration in seconds for video B
        raw_similarity_max: Maximum similarity across all frame pairs
        raw_similarity_mean: Mean of all best-match similarities
        raw_similarity_p95: 95th percentile of best-match similarities
        raw_similarity_p99: 99th percentile of best-match similarities
    """

    video_a: str
    video_b: str
    a_in_b: float
    b_in_a: float
    symmetric_similarity: float
    avg_similarity_a_to_b: float
    avg_similarity_b_to_a: float
    relation: str
    matches_a_to_b: List[FrameMatch] = field(default_factory=list)
    matches_b_to_a: List[FrameMatch] = field(default_factory=list)
    total_frames_a: int = 0
    total_frames_b: int = 0
    duration_a: float = 0.0
    duration_b: float = 0.0
    raw_similarity_max: float = 0.0
    raw_similarity_mean: float = 0.0
    raw_similarity_p95: float = 0.0
    raw_similarity_p99: float = 0.0

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "video_a": self.video_a,
            "video_b": self.video_b,
            "total_frames_a": self.total_frames_a,
            "total_frames_b": self.total_frames_b,
            "duration_a": self.duration_a,
            "duration_b": self.duration_b,
            "a_in_b": self.a_in_b,
            "b_in_a": self.b_in_a,
            "symmetric_similarity": self.symmetric_similarity,
            "avg_similarity_a_to_b": self.avg_similarity_a_to_b,
            "avg_similarity_b_to_a": self.avg_similarity_b_to_a,
            "relation": self.relation,
            "matches_a_to_b": [m.to_dict() for m in self.matches_a_to_b],
            "matches_b_to_a": [m.to_dict() for m in self.matches_b_to_a],
            "raw_similarity_max": self.raw_similarity_max,
            "raw_similarity_mean": self.raw_similarity_mean,
            "raw_similarity_p95": self.raw_similarity_p95,
            "raw_similarity_p99": self.raw_similarity_p99,
        }


def _query_index(
    query_embeddings: np.ndarray,
    target_index: faiss.Index,
    top_k: int,
    match_threshold: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Query a FAISS index with multiple query embeddings.

    Args:
        query_embeddings: Query embeddings of shape (N, D), should already be L2 normalized
        target_index: FAISS index to query
        top_k: Number of top results to retrieve per query
        match_threshold: Minimum similarity threshold for a match

    Returns:
        Tuple of (similarities, indices) each of shape (N, k) where k <= top_k
    """
    # Handle empty query
    if len(query_embeddings) == 0:
        return np.zeros((0, 0), dtype="float32"), np.zeros((0, 0), dtype=np.int64)

    # Handle empty index
    if target_index.ntotal == 0:
        n_queries = len(query_embeddings)
        return np.zeros((n_queries, 0), dtype="float32"), np.zeros((n_queries, 0), dtype=np.int64)

    # Ensure float32
    query = query_embeddings.astype("float32")

    # Normalize query embeddings (index already has normalized vectors)
    faiss.normalize_L2(query)

    # Search - k must be > 0 for FAISS
    k = min(top_k, target_index.ntotal)
    if k <= 0:
        n_queries = len(query_embeddings)
        return np.zeros((n_queries, 0), dtype="float32"), np.zeros((n_queries, 0), dtype=np.int64)

    similarities, indices = target_index.search(query, k)

    return similarities, indices


def _find_matches(
    source_embeddings: np.ndarray,
    source_frame_indices: np.ndarray,
    source_timestamps: np.ndarray,
    source_video: str,
    target_index_result: FrameIndexResult,
    target_video: str,
    top_k: int,
    match_threshold: float,
    source_thumbnail_paths: Optional[List[str]] = None,
    progress_callback: Optional[Callable[[int, int], None]] = None,
) -> Tuple[List[FrameMatch], int, float, np.ndarray]:
    """
    Find matches from source frames to target frames.

    Args:
        source_embeddings: Source frame embeddings (N, D)
        source_frame_indices: Source frame indices
        source_timestamps: Source frame timestamps
        source_video: Source video path
        target_index_result: Target FAISS index with metadata
        target_video: Target video path
        top_k: Number of top results per query
        match_threshold: Minimum similarity for a match

    Returns:
        Tuple of (matches, unique_matched_source_count, avg_best_similarity, all_best_similarities)
        - matches: All FrameMatch objects above threshold
        - unique_matched_source_count: Number of source frames with at least one target match
        - avg_best_similarity: Average of best-match similarity per source frame
        - all_best_similarities: Array of best similarity per source frame (for statistics)
    """
    # Handle empty source or target
    if len(source_embeddings) == 0 or target_index_result.num_frames == 0:
        return [], 0, 0.0, np.array([], dtype="float32")

    source_thumbnail_paths = source_thumbnail_paths or []
    query_count = len(source_embeddings)
    chunk_size = 128
    similarity_chunks = []
    index_chunks = []
    for start in range(0, query_count, chunk_size):
        end = min(start + chunk_size, query_count)
        similarities, indices = _query_index(
            source_embeddings[start:end],
            target_index_result.index,
            top_k,
            match_threshold,
        )
        similarity_chunks.append(similarities)
        index_chunks.append(indices)
        if progress_callback:
            progress_callback(end, query_count)

    similarities = np.vstack(similarity_chunks) if similarity_chunks else np.zeros((0, 0), dtype="float32")
    indices = np.vstack(index_chunks) if index_chunks else np.zeros((0, 0), dtype=np.int64)

    matches = []
    matched_source_indices = set()
    best_similarities = []  # Best match similarity per source frame

    for i, (sims, idxs) in enumerate(zip(similarities, indices)):
        frame_best_sim = -1.0
        frame_best_match = None
        source_frame_index = int(source_frame_indices[i])

        for sim, idx in zip(sims, idxs):
            if idx >= 0 and sim >= match_threshold:
                match = FrameMatch(
                    source_video=source_video,
                    target_video=target_video,
                    source_frame_index=source_frame_index,
                    target_frame_index=int(target_index_result.frame_indices[idx]),
                    source_timestamp=float(source_timestamps[i]),
                    target_timestamp=float(target_index_result.timestamps[idx]),
                    similarity=float(sim),
                    source_thumbnail_path=safe_list_get(source_thumbnail_paths, i),
                    target_thumbnail_path=safe_list_get(target_index_result.thumbnail_paths, int(idx)),
                )
                matches.append(match)
                matched_source_indices.add(source_frame_index)

                # Track best match for this source frame
                if sim > frame_best_sim:
                    frame_best_sim = float(sim)
                    frame_best_match = float(sim)

        # Record best similarity for this source frame (even if below threshold)
        # Get the top-1 similarity regardless of threshold for statistics
        if len(sims) > 0 and sims[0] >= 0:
            best_similarities.append(float(sims[0]))
        else:
            best_similarities.append(0.0)

    unique_matched_count = len(matched_source_indices)

    # Calculate avg_similarity only for frames that have matches above threshold
    matched_sims = [s for s in best_similarities if s >= match_threshold]
    avg_best_similarity = sum(matched_sims) / len(matched_sims) if matched_sims else 0.0

    return matches, unique_matched_count, avg_best_similarity, np.array(best_similarities, dtype="float32")


def _determine_relation(
    a_in_b: float,
    b_in_a: float,
    total_frames_a: int = 0,
    total_frames_b: int = 0,
    duration_a: float = 0.0,
    duration_b: float = 0.0,
) -> str:
    """
    Determine the relationship between two videos based on containment ratios.

    Args:
        a_in_b: Ratio of A frames matched in B
        b_in_a: Ratio of B frames matched in A

    Returns:
        Relation string
    """
    directional_gap = 0.18
    clip_threshold = 0.65
    duration_ratio = 1.35
    frame_ratio = 1.35

    a_longer_by_duration = duration_a > 0 and duration_b > 0 and duration_a >= duration_b * duration_ratio
    b_longer_by_duration = duration_a > 0 and duration_b > 0 and duration_b >= duration_a * duration_ratio
    a_longer_by_frames = total_frames_a > 0 and total_frames_b > 0 and total_frames_a >= total_frames_b * frame_ratio
    b_longer_by_frames = total_frames_a > 0 and total_frames_b > 0 and total_frames_b >= total_frames_a * frame_ratio

    # If the original media lengths are clearly different, prefer a containment
    # label over "near duplicate" even when sparse dynamic sampling makes both
    # directional ratios look high.
    if (a_longer_by_duration or a_longer_by_frames) and b_in_a >= clip_threshold:
        return "B_is_likely_clip_of_A"
    if (b_longer_by_duration or b_longer_by_frames) and a_in_b >= clip_threshold:
        return "A_is_likely_clip_of_B"

    if b_in_a >= 0.75 and (b_in_a - a_in_b) >= directional_gap:
        return "B_is_likely_clip_of_A"
    elif a_in_b >= 0.75 and (a_in_b - b_in_a) >= directional_gap:
        return "A_is_likely_clip_of_B"
    elif a_in_b >= 0.80 and b_in_a >= 0.80:
        return "near_duplicate_or_same_content"
    elif max(a_in_b, b_in_a) >= 0.50:
        return "partial_overlap"
    else:
        return "different"


def _temporal_consistent_coverage(
    matches: List[FrameMatch],
    total_source_frames: int,
    offset_tolerance_sec: float = TEMPORAL_OFFSET_TOLERANCE_SEC,
) -> float:
    """
    Estimate containment using time-consistent matches.

    A loose visual model can find semantically similar frames across unrelated
    parts of a long video. For containment, those matches should also share a
    stable target-source time offset. This keeps a short noisy clip from turning
    the whole long source into a false 100% match.
    """
    if total_source_frames <= 0 or not matches:
        return 0.0

    sorted_matches = sorted(
        matches,
        key=lambda match: match.target_timestamp - match.source_timestamp,
    )
    if not sorted_matches:
        return 0.0

    min_cluster_matches = min(3, len(sorted_matches), total_source_frames)
    best_covered_source_frames = set()
    best_cluster_score = 0.0
    current_cluster: List[FrameMatch] = []
    current_offset = 0.0

    def commit_cluster(cluster: List[FrameMatch]) -> None:
        nonlocal best_cluster_score, best_covered_source_frames
        if len(cluster) < min_cluster_matches:
            return
        source_times = [match.source_timestamp for match in cluster]
        target_times = [match.target_timestamp for match in cluster]
        source_span = max(source_times) - min(source_times)
        target_span = max(target_times) - min(target_times)
        # Very short clusters are allowed only when the source itself has very
        # few retained frames. Otherwise require a little temporal extent.
        if total_source_frames > 3 and max(source_span, target_span) < 1.0:
            return

        source_frames = {match.source_frame_index for match in cluster}
        avg_similarity = sum(match.similarity for match in cluster) / len(cluster)
        cluster_score = len(source_frames) * max(0.0, avg_similarity)
        if cluster_score > best_cluster_score:
            best_cluster_score = cluster_score
            best_covered_source_frames = source_frames

    for match in sorted_matches:
        offset = match.target_timestamp - match.source_timestamp
        if not current_cluster:
            current_cluster = [match]
            current_offset = offset
            continue

        if abs(offset - current_offset) <= offset_tolerance_sec:
            current_cluster.append(match)
            current_offset = sum(
                item.target_timestamp - item.source_timestamp
                for item in current_cluster
            ) / len(current_cluster)
        else:
            commit_cluster(current_cluster)
            current_cluster = [match]
            current_offset = offset

    commit_cluster(current_cluster)
    return min(1.0, len(best_covered_source_frames) / total_source_frames)


def _cache_duration_seconds(cache: FrameEmbeddingCache) -> float:
    """Best-effort media duration estimate carried with a frame cache."""
    metadata = cache.metadata or {}
    for key in ("duration_sec", "source_duration_sec", "retained_duration_sec"):
        value = metadata.get(key)
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        if numeric > 0:
            return numeric

    if len(cache.timestamps) > 0:
        return float(np.max(cache.timestamps))
    return 0.0


def compare_videos_bidirectional(
    cache_a: FrameEmbeddingCache,
    cache_b: FrameEmbeddingCache,
    match_threshold: float = 0.65,
    top_k: int = 10,
    progress_callback: Optional[Callable[[str, int, int], None]] = None,
) -> ContainmentResult:
    """
    Perform bidirectional containment detection between two videos.

    Args:
        cache_a: Frame embedding cache for video A
        cache_b: Frame embedding cache for video B
        match_threshold: Minimum similarity threshold for a match (default: 0.65)
        top_k: Number of top results to retrieve per query

    Returns:
        ContainmentResult with containment ratios and matches

    Raises:
        ValueError: If embedding dimensions don't match between caches
    """
    # Check embedding dimension consistency
    dim_a = cache_a.embeddings.shape[1] if cache_a.embeddings.ndim == 2 and len(cache_a.embeddings) > 0 else 0
    dim_b = cache_b.embeddings.shape[1] if cache_b.embeddings.ndim == 2 and len(cache_b.embeddings) > 0 else 0

    if dim_a > 0 and dim_b > 0 and dim_a != dim_b:
        raise ValueError(
            f"Embedding dimension mismatch: A has {dim_a} dims, B has {dim_b} dims. "
            "This usually means stale cache generated by another model/version. "
            "Please delete cache or rerun with --force."
        )

    # Build FAISS indices. Batch workflows should call
    # compare_frame_indexes_bidirectional with prebuilt indices to avoid doing
    # this repeatedly for every pair.
    index_a = build_frame_index(cache_a)
    index_b = build_frame_index(cache_b)

    return compare_frame_indexes_bidirectional(
        cache_a=cache_a,
        cache_b=cache_b,
        index_a=index_a,
        index_b=index_b,
        match_threshold=match_threshold,
        top_k=top_k,
        progress_callback=progress_callback,
    )


def compare_frame_indexes_bidirectional(
    cache_a: FrameEmbeddingCache,
    cache_b: FrameEmbeddingCache,
    index_a: FrameIndexResult,
    index_b: FrameIndexResult,
    match_threshold: float = 0.65,
    top_k: int = 10,
    progress_callback: Optional[Callable[[str, int, int], None]] = None,
) -> ContainmentResult:
    """
    Perform bidirectional containment detection with prebuilt frame indices.

    This is the fast path for batch analysis: each video's FAISS index can be
    built once and reused across all pair comparisons.
    """
    dim_a = cache_a.embeddings.shape[1] if cache_a.embeddings.ndim == 2 and len(cache_a.embeddings) > 0 else 0
    dim_b = cache_b.embeddings.shape[1] if cache_b.embeddings.ndim == 2 and len(cache_b.embeddings) > 0 else 0

    if dim_a > 0 and dim_b > 0 and dim_a != dim_b:
        raise ValueError(
            f"Embedding dimension mismatch: A has {dim_a} dims, B has {dim_b} dims. "
            "This usually means stale cache generated by another model/version. "
            "Please delete cache or rerun with --force."
        )

    total_frames_a = index_a.num_frames
    total_frames_b = index_b.num_frames
    duration_a = _cache_duration_seconds(cache_a)
    duration_b = _cache_duration_seconds(cache_b)

    # A -> B: Query B's index with A's embeddings
    matches_a_to_b, unique_matched_a, avg_sim_a_to_b, best_sims_a = _find_matches(
        source_embeddings=cache_a.embeddings,
        source_frame_indices=cache_a.frame_indices,
        source_timestamps=cache_a.timestamps,
        source_video=cache_a.video_path,
        target_index_result=index_b,
        target_video=cache_b.video_path,
        top_k=top_k,
        match_threshold=match_threshold,
        source_thumbnail_paths=cache_a.thumbnail_paths,
        progress_callback=(
            (lambda done, total: progress_callback("a_to_b", done, total))
            if progress_callback
            else None
        ),
    )

    # B -> A: Query A's index with B's embeddings
    matches_b_to_a, unique_matched_b, avg_sim_b_to_a, best_sims_b = _find_matches(
        source_embeddings=cache_b.embeddings,
        source_frame_indices=cache_b.frame_indices,
        source_timestamps=cache_b.timestamps,
        source_video=cache_b.video_path,
        target_index_result=index_a,
        target_video=cache_a.video_path,
        top_k=top_k,
        match_threshold=match_threshold,
        source_thumbnail_paths=cache_b.thumbnail_paths,
        progress_callback=(
            (lambda done, total: progress_callback("b_to_a", done, total))
            if progress_callback
            else None
        ),
    )

    # Calculate containment ratios from time-consistent matches. The raw unique
    # match count is too permissive for long videos because semantically similar
    # but unrelated frames can appear throughout the source.
    a_in_b = _temporal_consistent_coverage(matches_a_to_b, total_frames_a)
    b_in_a = _temporal_consistent_coverage(matches_b_to_a, total_frames_b)
    symmetric_similarity = (a_in_b + b_in_a) / 2

    # Calculate raw similarity statistics (combine best similarities from both directions)
    all_best_sims = np.concatenate([best_sims_a, best_sims_b]) if len(best_sims_a) > 0 or len(best_sims_b) > 0 else np.array([], dtype="float32")

    if len(all_best_sims) > 0:
        raw_similarity_max = float(np.max(all_best_sims))
        raw_similarity_mean = float(np.mean(all_best_sims))
        raw_similarity_p95 = float(np.percentile(all_best_sims, 95))
        raw_similarity_p99 = float(np.percentile(all_best_sims, 99))
    else:
        raw_similarity_max = 0.0
        raw_similarity_mean = 0.0
        raw_similarity_p95 = 0.0
        raw_similarity_p99 = 0.0

    # Determine relation
    relation = _determine_relation(
        a_in_b,
        b_in_a,
        total_frames_a=total_frames_a,
        total_frames_b=total_frames_b,
        duration_a=duration_a,
        duration_b=duration_b,
    )

    return ContainmentResult(
        video_a=cache_a.video_path,
        video_b=cache_b.video_path,
        a_in_b=a_in_b,
        b_in_a=b_in_a,
        symmetric_similarity=symmetric_similarity,
        avg_similarity_a_to_b=avg_sim_a_to_b,
        avg_similarity_b_to_a=avg_sim_b_to_a,
        relation=relation,
        matches_a_to_b=matches_a_to_b,
        matches_b_to_a=matches_b_to_a,
        total_frames_a=total_frames_a,
        total_frames_b=total_frames_b,
        duration_a=duration_a,
        duration_b=duration_b,
        raw_similarity_max=raw_similarity_max,
        raw_similarity_mean=raw_similarity_mean,
        raw_similarity_p95=raw_similarity_p95,
        raw_similarity_p99=raw_similarity_p99,
    )


def safe_list_get(values: List[str], index: int) -> Optional[str]:
    if index < 0 or index >= len(values):
        return None
    return values[index]


class VideoMatcher:
    """
    Video similarity matcher using FAISS.

    Finds similar videos by comparing embeddings against a pre-built index.
    """

    def __init__(
        self,
        index_path: Optional[Union[str, Path]] = None,
        meta_path: Optional[Union[str, Path]] = None,
        use_legacy_paths: bool = False,
    ):
        """
        Initialize the video matcher.

        Args:
            index_path: Path to the FAISS index file
            meta_path: Path to the metadata file
            use_legacy_paths: Whether to use legacy paths (project root)
        """
        if use_legacy_paths:
            self.index_path = Path(index_path) if index_path else Config.get_legacy_index_path()
            self.meta_path = Path(meta_path) if meta_path else Config.get_legacy_meta_path()
        else:
            self.index_path = Path(index_path) if index_path else Config.get_index_path()
            self.meta_path = Path(meta_path) if meta_path else Config.get_meta_path()

        self.index: Optional[faiss.Index] = None
        self.meta: List[str] = []

    def load(
        self,
        index_path: Optional[Union[str, Path]] = None,
        meta_path: Optional[Union[str, Path]] = None,
    ) -> None:
        """
        Load the FAISS index and metadata.

        Args:
            index_path: Path to the index file
            meta_path: Path to the metadata file
        """
        idx_path = Path(index_path) if index_path else self.index_path
        mt_path = Path(meta_path) if meta_path else self.meta_path

        self.index = faiss.read_index(str(idx_path))

        with open(mt_path, "r", encoding="utf-8") as f:
            self.meta = [line.strip() for line in f.readlines()]

        print(f"Loaded index with {self.index.ntotal} vectors")

    def search(
        self,
        query_embedding: np.ndarray,
        top_k: int = 5,
    ) -> List[SearchResult]:
        """
        Search for similar videos.

        Args:
            query_embedding: Query embedding vector (will be normalized)
            top_k: Number of results to return

        Returns:
            List of (video_name, similarity_score) tuples
        """
        if self.index is None:
            raise ValueError("Index not loaded. Call load() first.")

        # Ensure correct shape and type
        query = query_embedding.astype("float32").reshape(1, -1)
        faiss.normalize_L2(query)

        # Search
        distances, indices = self.index.search(query, min(top_k, self.index.ntotal))

        # Build results
        results = []
        for idx, dist in zip(indices[0], distances[0]):
            if idx >= 0:  # Valid index
                results.append((self.meta[idx], float(dist)))

        return results

    def search_by_video(
        self,
        video_path: Union[str, Path],
        top_k: int = 5,
        embedder: Optional[VideoEmbedder] = None,
    ) -> List[SearchResult]:
        """
        Search for similar videos using a video file.

        Args:
            video_path: Path to the query video
            top_k: Number of results to return
            embedder: VideoEmbedder instance (created if None)

        Returns:
            List of (video_name, similarity_score) tuples
        """
        if embedder is None:
            embedder = get_embedder()

        # Extract frames and compute embedding
        frames = sample_frames(str(video_path))
        query_embedding = embedder.embed(frames)

        return self.search(query_embedding, top_k)

    def search_by_embedding_file(
        self,
        embedding_path: Union[str, Path],
        top_k: int = 5,
    ) -> List[SearchResult]:
        """
        Search for similar videos using a pre-computed embedding file.

        Args:
            embedding_path: Path to the .npy embedding file
            top_k: Number of results to return

        Returns:
            List of (video_name, similarity_score) tuples
        """
        query_embedding = np.load(embedding_path)
        return self.search(query_embedding, top_k)


def load_index(
    index_file: Union[str, Path] = "faiss_video_index.bin",
    meta_file: Union[str, Path] = "video_meta.txt",
) -> Tuple[faiss.Index, List[str]]:
    """
    Load FAISS index and metadata (module-level function for backward compatibility).

    Args:
        index_file: Path to the index file
        meta_file: Path to the metadata file

    Returns:
        Tuple of (index, metadata_list)
    """
    index = faiss.read_index(str(index_file))
    with open(meta_file, "r", encoding="utf-8") as f:
        meta = [line.strip() for line in f.readlines()]
    return index, meta


def query(
    video_path: Union[str, Path],
    top_k: int = 5,
    index_file: Union[str, Path] = "faiss_video_index.bin",
    meta_file: Union[str, Path] = "video_meta.txt",
) -> List[SearchResult]:
    """
    Query for similar videos (module-level function for backward compatibility).

    Args:
        video_path: Path to the query video
        top_k: Number of results to return
        index_file: Path to the index file
        meta_file: Path to the metadata file

    Returns:
        List of (video_name, similarity_score) tuples
    """
    matcher = VideoMatcher(index_path=index_file, meta_path=meta_file)
    matcher.load()
    return matcher.search_by_video(video_path, top_k)
