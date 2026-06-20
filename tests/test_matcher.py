"""
Tests for video_sim.matcher - Bidirectional containment detection.

Uses artificial vectors to verify:
- a_in_b / b_in_a calculations
- relation determination
- match filtering
"""

import numpy as np
import pytest

from video_sim.embedder import FrameEmbeddingCache
from video_sim.indexer import FrameIndexResult, build_frame_index
from video_sim.matcher import (
    ContainmentResult,
    FrameMatch,
    _determine_relation,
    _find_matches,
    compare_videos_bidirectional,
)


def create_test_cache(
    video_path: str,
    embeddings: np.ndarray,
    frame_indices: np.ndarray = None,
    timestamps: np.ndarray = None,
) -> FrameEmbeddingCache:
    """
    Create a test FrameEmbeddingCache with artificial data.

    Args:
        video_path: Path string for the video
        embeddings: 2D array of embeddings (N, D)
        frame_indices: Frame indices (defaults to 0, 1, 2, ...)
        timestamps: Timestamps in seconds (defaults to frame_index * 0.5)

    Returns:
        FrameEmbeddingCache instance
    """
    n = len(embeddings)
    if frame_indices is None:
        frame_indices = np.arange(n)
    if timestamps is None:
        timestamps = frame_indices.astype(float) * 0.5

    return FrameEmbeddingCache(
        video_path=video_path,
        frame_indices=frame_indices,
        timestamps=timestamps,
        phashes=[f"phash_{i}" for i in range(n)],
        thumbnail_paths=[f"thumb_{i}.jpg" for i in range(n)],
        embeddings=embeddings.astype("float32"),
    )


def normalize_embeddings(embeddings: np.ndarray) -> np.ndarray:
    """L2 normalize embeddings."""
    norms = np.linalg.norm(embeddings, axis=-1, keepdims=True)
    norms = np.where(norms == 0, 1.0, norms)
    return (embeddings / norms).astype("float32")


class TestDetermineRelation:
    """Tests for _determine_relation function."""

    def test_b_is_clip_of_a(self):
        """B contains most of A, but A doesn't contain much of B."""
        # b_in_a=0.90 (B frames mostly found in A), a_in_b=0.50 (A frames rarely found in B)
        assert _determine_relation(0.50, 0.90) == "B_is_likely_clip_of_A"

    def test_a_is_clip_of_b(self):
        """A contains most of B, but B doesn't contain much of A."""
        # a_in_b=0.90 (A frames mostly found in B), b_in_a=0.50 (B frames rarely found in A)
        assert _determine_relation(0.90, 0.50) == "A_is_likely_clip_of_B"

    def test_longer_b_forces_a_clip_direction(self):
        """A shorter source covered by a clearly longer B must be A's clip of B."""
        assert _determine_relation(
            0.92,
            0.88,
            total_frames_a=120,
            total_frames_b=420,
            duration_a=240.0,
            duration_b=1200.0,
        ) == "A_is_likely_clip_of_B"

    def test_longer_a_forces_b_clip_direction(self):
        """B shorter than A must not be mislabeled as containing A."""
        assert _determine_relation(
            0.86,
            0.93,
            total_frames_a=500,
            total_frames_b=140,
            duration_a=1500.0,
            duration_b=300.0,
        ) == "B_is_likely_clip_of_A"

    def test_near_duplicate(self):
        """Both videos contain most of each other's frames."""
        assert _determine_relation(0.85, 0.85) == "near_duplicate_or_same_content"
        assert _determine_relation(0.80, 0.80) == "near_duplicate_or_same_content"
        assert _determine_relation(0.95, 0.95) == "near_duplicate_or_same_content"

    def test_partial_overlap(self):
        """Significant overlap but not enough for clip or duplicate."""
        assert _determine_relation(0.60, 0.40) == "partial_overlap"
        assert _determine_relation(0.40, 0.60) == "partial_overlap"
        assert _determine_relation(0.50, 0.30) == "partial_overlap"

    def test_different(self):
        """Videos are different."""
        assert _determine_relation(0.10, 0.10) == "different"
        assert _determine_relation(0.40, 0.40) == "different"
        assert _determine_relation(0.0, 0.0) == "different"

    def test_boundary_cases(self):
        """Test boundary values for relation determination."""
        # Just below B_is_clip_of_A threshold
        assert _determine_relation(0.65, 0.84) != "B_is_likely_clip_of_A"
        # Just at B_is_clip_of_A threshold
        assert _determine_relation(0.64, 0.85) == "B_is_likely_clip_of_A"

        # Just below A_is_clip_of_B threshold
        assert _determine_relation(0.84, 0.65) != "A_is_likely_clip_of_B"
        # Just at A_is_clip_of_B threshold
        assert _determine_relation(0.85, 0.64) == "A_is_likely_clip_of_B"


class TestFindMatches:
    """Tests for _find_matches function."""

    def test_perfect_match(self):
        """Test perfect matching between identical embeddings."""
        # Create identical embeddings
        n = 5
        dim = 64
        embeddings = np.random.randn(n, dim).astype("float32")
        embeddings = normalize_embeddings(embeddings)

        # Create cache
        cache = create_test_cache("video_a.mp4", embeddings)
        index_result = build_frame_index(cache)

        # Find matches (should all match with similarity ~1.0)
        matches, unique_count, avg_sim, _best_sims = _find_matches(
            source_embeddings=embeddings,
            source_frame_indices=cache.frame_indices,
            source_timestamps=cache.timestamps,
            source_video="video_a.mp4",
            target_index_result=index_result,
            target_video="video_a.mp4",
            top_k=3,
            match_threshold=0.95,
        )

        # All frames should match themselves
        assert unique_count == n
        assert len(matches) >= n
        assert avg_sim > 0.99

    def test_no_match_below_threshold(self):
        """Test that no matches are returned when threshold is too high."""
        # Create random embeddings
        n = 5
        dim = 64
        np.random.seed(42)
        embeddings_a = normalize_embeddings(np.random.randn(n, dim).astype("float32"))
        embeddings_b = normalize_embeddings(np.random.randn(n, dim).astype("float32"))

        cache_a = create_test_cache("video_a.mp4", embeddings_a)
        cache_b = create_test_cache("video_b.mp4", embeddings_b)
        index_b = build_frame_index(cache_b)

        # Use very high threshold - random vectors should have lower similarity
        matches, unique_count, avg_sim, _best_sims = _find_matches(
            source_embeddings=embeddings_a,
            source_frame_indices=cache_a.frame_indices,
            source_timestamps=cache_a.timestamps,
            source_video="video_a.mp4",
            target_index_result=index_b,
            target_video="video_b.mp4",
            top_k=3,
            match_threshold=0.99,
        )

        # Random vectors should not have similarity > 0.99
        assert unique_count == 0
        assert len(matches) == 0
        assert avg_sim == 0.0

    def test_containment_counts_matched_source_frames(self):
        """Containment ratio should count source frames that find a match, not unique target frames."""
        dim = 3
        source_embeddings = normalize_embeddings(
            np.array(
                [
                    [1.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                ],
                dtype="float32",
            )
        )
        target_embeddings = normalize_embeddings(
            np.array([[1.0, 0.0, 0.0]], dtype="float32")
        )
        source_cache = create_test_cache("source.mp4", source_embeddings)
        target_cache = create_test_cache("target.mp4", target_embeddings)

        matches, unique_count, avg_sim, _best_sims = _find_matches(
            source_embeddings=source_embeddings,
            source_frame_indices=source_cache.frame_indices,
            source_timestamps=source_cache.timestamps,
            source_video="source.mp4",
            target_index_result=build_frame_index(target_cache),
            target_video="target.mp4",
            top_k=1,
            match_threshold=0.95,
        )

        assert len(matches) == 3
        assert unique_count == 3
        assert avg_sim > 0.99


class TestCompareVideosBidirectional:
    """Tests for compare_videos_bidirectional function."""

    def test_identical_videos(self):
        """Test comparison of identical videos."""
        n = 10
        dim = 64
        embeddings = normalize_embeddings(np.random.randn(n, dim).astype("float32"))

        cache_a = create_test_cache("video_a.mp4", embeddings)
        cache_b = create_test_cache("video_b.mp4", embeddings)

        result = compare_videos_bidirectional(
            cache_a=cache_a,
            cache_b=cache_b,
            match_threshold=0.95,
            top_k=3,
        )

        # Identical videos should have high containment both ways
        assert result.a_in_b > 0.95
        assert result.b_in_a > 0.95
        assert result.symmetric_similarity > 0.95
        assert result.relation == "near_duplicate_or_same_content"

    def test_b_is_clip_of_a(self):
        """Test detection when B is a clip of A."""
        np.random.seed(42)
        dim = 64

        # A has 20 frames
        n_a = 20
        embeddings_a = normalize_embeddings(np.random.randn(n_a, dim).astype("float32"))

        # B has 10 frames, all from the middle of A
        embeddings_b = embeddings_a[5:15].copy()

        cache_a = create_test_cache("video_a.mp4", embeddings_a)
        cache_b = create_test_cache("video_b.mp4", embeddings_b)

        result = compare_videos_bidirectional(
            cache_a=cache_a,
            cache_b=cache_b,
            match_threshold=0.95,
            top_k=3,
        )

        # All B frames should match A frames (b_in_a ~ 1.0)
        assert result.b_in_a > 0.95

        # Only half of A frames match B (a_in_b ~ 0.5)
        assert result.a_in_b < 0.7

        # B is a clip of A
        assert result.relation == "B_is_likely_clip_of_A"

    def test_a_is_clip_of_b(self):
        """Test detection when A is a clip of B."""
        np.random.seed(42)
        dim = 64

        # B has 20 frames
        n_b = 20
        embeddings_b = normalize_embeddings(np.random.randn(n_b, dim).astype("float32"))

        # A has 10 frames, all from the middle of B
        embeddings_a = embeddings_b[5:15].copy()

        cache_a = create_test_cache("video_a.mp4", embeddings_a)
        cache_b = create_test_cache("video_b.mp4", embeddings_b)

        result = compare_videos_bidirectional(
            cache_a=cache_a,
            cache_b=cache_b,
            match_threshold=0.95,
            top_k=3,
        )

        # All A frames should match B frames (a_in_b ~ 1.0)
        assert result.a_in_b > 0.95

        # Only half of B frames match A (b_in_a ~ 0.5)
        assert result.b_in_a < 0.7

        # A is a clip of B
        assert result.relation == "A_is_likely_clip_of_B"

    def test_partial_overlap(self):
        """Test detection when videos have partial overlap."""
        np.random.seed(42)
        dim = 64

        # A has 10 frames
        embeddings_a_shared = normalize_embeddings(np.random.randn(5, dim).astype("float32"))
        embeddings_a_unique = normalize_embeddings(np.random.randn(5, dim).astype("float32"))
        embeddings_a = np.vstack([embeddings_a_shared, embeddings_a_unique])

        # B has 10 frames, 5 shared with A, 5 unique
        embeddings_b_unique = normalize_embeddings(np.random.randn(5, dim).astype("float32"))
        embeddings_b = np.vstack([embeddings_a_shared, embeddings_b_unique])

        cache_a = create_test_cache("video_a.mp4", embeddings_a)
        cache_b = create_test_cache("video_b.mp4", embeddings_b)

        result = compare_videos_bidirectional(
            cache_a=cache_a,
            cache_b=cache_b,
            match_threshold=0.95,
            top_k=3,
        )

        # About half of each video should match the other
        assert 0.3 < result.a_in_b < 0.7
        assert 0.3 < result.b_in_a < 0.7
        assert result.relation == "partial_overlap"

    def test_different_videos(self):
        """Test detection when videos are different."""
        np.random.seed(42)
        dim = 64

        # Completely random embeddings for both
        embeddings_a = normalize_embeddings(np.random.randn(10, dim).astype("float32"))
        embeddings_b = normalize_embeddings(np.random.randn(10, dim).astype("float32"))

        cache_a = create_test_cache("video_a.mp4", embeddings_a)
        cache_b = create_test_cache("video_b.mp4", embeddings_b)

        result = compare_videos_bidirectional(
            cache_a=cache_a,
            cache_b=cache_b,
            match_threshold=0.90,
            top_k=3,
        )

        # Random vectors should have low match rates
        assert result.a_in_b < 0.5
        assert result.b_in_a < 0.5
        assert result.relation == "different"

    def test_empty_video(self):
        """Test handling of empty video cache."""
        dim = 64
        embeddings = normalize_embeddings(np.random.randn(5, dim).astype("float32"))

        # Create empty cache for B
        cache_a = create_test_cache("video_a.mp4", embeddings)
        cache_b = create_test_cache("video_b.mp4", np.zeros((0, dim), dtype="float32"))
        cache_b.frame_indices = np.array([], dtype=np.int64)
        cache_b.timestamps = np.array([], dtype=np.float64)
        cache_b.phashes = []
        cache_b.thumbnail_paths = []

        result = compare_videos_bidirectional(
            cache_a=cache_a,
            cache_b=cache_b,
            match_threshold=0.82,
            top_k=3,
        )

        # With empty B, a_in_b should be 0 (no matches)
        assert result.a_in_b == 0.0
        # b_in_a should also be 0 (B has no frames)
        assert result.b_in_a == 0.0
        assert result.total_frames_a == 5
        assert result.total_frames_b == 0


class TestFrameMatch:
    """Tests for FrameMatch dataclass."""

    def test_to_dict(self):
        """Test FrameMatch serialization to dictionary."""
        match = FrameMatch(
            source_video="video_a.mp4",
            target_video="video_b.mp4",
            source_frame_index=5,
            target_frame_index=10,
            source_timestamp=2.5,
            target_timestamp=5.0,
            similarity=0.95,
        )

        d = match.to_dict()
        assert d["source_video"] == "video_a.mp4"
        assert d["target_video"] == "video_b.mp4"
        assert d["source_frame_index"] == 5
        assert d["target_frame_index"] == 10
        assert d["source_timestamp"] == 2.5
        assert d["target_timestamp"] == 5.0
        assert d["similarity"] == 0.95


class TestContainmentResult:
    """Tests for ContainmentResult dataclass."""

    def test_to_dict(self):
        """Test ContainmentResult serialization to dictionary."""
        matches = [
            FrameMatch("a.mp4", "b.mp4", 0, 0, 0.0, 0.0, 0.99),
        ]

        result = ContainmentResult(
            video_a="video_a.mp4",
            video_b="video_b.mp4",
            a_in_b=0.8,
            b_in_a=0.6,
            symmetric_similarity=0.7,
            avg_similarity_a_to_b=0.85,
            avg_similarity_b_to_a=0.75,
            relation="partial_overlap",
            matches_a_to_b=matches,
            matches_b_to_a=[],
            total_frames_a=10,
            total_frames_b=15,
        )

        d = result.to_dict()
        assert d["video_a"] == "video_a.mp4"
        assert d["video_b"] == "video_b.mp4"
        assert d["a_in_b"] == 0.8
        assert d["b_in_a"] == 0.6
        assert d["symmetric_similarity"] == 0.7
        assert d["relation"] == "partial_overlap"
        assert d["total_frames_a"] == 10
        assert d["total_frames_b"] == 15
        assert len(d["matches_a_to_b"]) == 1
        assert len(d["matches_b_to_a"]) == 0
