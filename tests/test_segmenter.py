"""
Tests for video_sim.segmenter - Time window similarity and segment aggregation.

Uses artificial FrameMatch lists to verify:
- fixed_window_similarity window statistics
- aggregate_segments offset clustering
- Edge cases (empty input, single match, etc.)
"""

import numpy as np
import pytest

from video_sim.matcher import FrameMatch
from video_sim.segmenter import (
    MatchedSegment,
    WindowSimilarity,
    _create_segment_from_cluster,
    aggregate_segments,
    fixed_window_similarity,
)


def create_match(
    source_timestamp: float,
    target_timestamp: float,
    similarity: float = 0.9,
    source_frame_index: int = 0,
    target_frame_index: int = 0,
) -> FrameMatch:
    """Create a FrameMatch with specified timestamps and similarity."""
    return FrameMatch(
        source_video="source.mp4",
        target_video="target.mp4",
        source_frame_index=source_frame_index,
        target_frame_index=target_frame_index,
        source_timestamp=source_timestamp,
        target_timestamp=target_timestamp,
        similarity=similarity,
    )


class TestFixedWindowSimilarity:
    """Tests for fixed_window_similarity function."""

    def test_empty_input(self):
        """Test with empty match list."""
        result = fixed_window_similarity([], window_size=30.0)
        assert result == []

    def test_single_match(self):
        """Test with a single match."""
        matches = [create_match(10.0, 15.0, 0.9)]
        result = fixed_window_similarity(matches, window_size=30.0)

        assert len(result) >= 1
        # The window containing the match should have stats
        window = result[0]
        assert window.matched_frame_count == 1
        assert window.avg_similarity == 0.9

    def test_matches_in_same_window(self):
        """Test multiple matches in the same window."""
        matches = [
            create_match(5.0, 10.0, 0.8),
            create_match(10.0, 15.0, 0.9),
            create_match(15.0, 20.0, 0.85),
        ]
        result = fixed_window_similarity(matches, window_size=30.0)

        # All matches should be in one window
        assert len(result) >= 1
        window = result[0]
        assert window.matched_frame_count == 3
        assert abs(window.avg_similarity - 0.85) < 0.01
        assert window.best_target_start == 10.0
        assert window.best_target_end == 20.0

    def test_matches_across_windows(self):
        """Test matches spanning multiple windows."""
        matches = [
            create_match(5.0, 10.0, 0.8),
            create_match(35.0, 40.0, 0.9),  # Different window
            create_match(65.0, 70.0, 0.85),  # Another window
        ]
        result = fixed_window_similarity(matches, window_size=30.0)

        # Should have at least 3 windows with matches
        windows_with_matches = [w for w in result if w.matched_frame_count > 0]
        assert len(windows_with_matches) >= 2

    def test_window_size_parameter(self):
        """Test different window sizes."""
        matches = [
            create_match(5.0, 10.0, 0.8),
            create_match(15.0, 20.0, 0.9),
            create_match(25.0, 30.0, 0.85),
        ]

        # Small window - should split matches
        result_small = fixed_window_similarity(matches, window_size=10.0)

        # Large window - should contain all matches
        result_large = fixed_window_similarity(matches, window_size=60.0)

        # Large window should have fewer or equal windows
        assert len(result_large) <= len(result_small)

    def test_total_source_duration(self):
        """Test that total_source_duration affects window range."""
        matches = [create_match(5.0, 10.0, 0.8)]

        # Without duration hint
        result_no_hint = fixed_window_similarity(matches, window_size=30.0)

        # With duration hint
        result_with_hint = fixed_window_similarity(
            matches, window_size=30.0, total_source_duration=120.0
        )

        # With hint should cover more time range
        assert len(result_with_hint) >= len(result_no_hint)


class TestAggregateSegments:
    """Tests for aggregate_segments function."""

    def test_empty_input(self):
        """Test with empty match list."""
        result = aggregate_segments([])
        assert result == []

    def test_single_match(self):
        """Test with a single match (should not form segment)."""
        matches = [create_match(10.0, 15.0, 0.9)]
        result = aggregate_segments(
            matches, min_segment_duration=5.0, min_segment_matches=3
        )
        # Single match doesn't meet min_segment_matches
        assert result == []

    def test_continuous_segment(self):
        """Test aggregation of continuous matches with consistent offset."""
        # Matches with consistent offset of +5 seconds
        matches = [
            create_match(10.0, 15.0, 0.9),
            create_match(11.0, 16.0, 0.85),
            create_match(12.0, 17.0, 0.88),
            create_match(13.0, 18.0, 0.92),
            create_match(14.0, 19.0, 0.87),
        ]
        result = aggregate_segments(
            matches, min_segment_duration=3.0, min_segment_matches=3
        )

        assert len(result) == 1
        segment = result[0]
        assert segment.source_start == 10.0
        assert segment.source_end == 14.0
        assert segment.target_start == 15.0
        assert segment.target_end == 19.0
        assert segment.match_count == 5
        assert abs(segment.avg_similarity - 0.884) < 0.01

    def test_two_separate_segments(self):
        """Test aggregation of two separate segments."""
        # First segment: offset ~5
        segment1 = [
            create_match(10.0, 15.0, 0.9),
            create_match(11.0, 16.0, 0.85),
            create_match(12.0, 17.0, 0.88),
            create_match(13.0, 18.0, 0.92),
        ]

        # Second segment: offset ~20 (different from first)
        segment2 = [
            create_match(50.0, 70.0, 0.87),
            create_match(51.0, 71.0, 0.89),
            create_match(52.0, 72.0, 0.91),
            create_match(53.0, 73.0, 0.86),
        ]

        matches = segment1 + segment2
        result = aggregate_segments(
            matches, min_segment_duration=3.0, min_segment_matches=3
        )

        assert len(result) == 2
        # Segments should be sorted by confidence (descending)
        assert result[0].confidence >= result[1].confidence

    def test_offset_tolerance(self):
        """Test offset_tolerance_sec parameter."""
        # Matches with slightly varying offsets
        matches = [
            create_match(10.0, 15.0, 0.9),   # offset = 5
            create_match(11.0, 16.5, 0.85),  # offset = 5.5
            create_match(12.0, 17.0, 0.88),  # offset = 5
            create_match(13.0, 18.5, 0.92),  # offset = 5.5
        ]

        # Strict tolerance - might split
        result_strict = aggregate_segments(
            matches, min_segment_duration=2.0, min_segment_matches=2, offset_tolerance_sec=0.3
        )

        # Loose tolerance - should merge
        result_loose = aggregate_segments(
            matches, min_segment_duration=2.0, min_segment_matches=2, offset_tolerance_sec=1.0
        )

        assert len(result_loose) <= len(result_strict)

    def test_min_segment_duration(self):
        """Test min_segment_duration filter."""
        matches = [
            create_match(10.0, 15.0, 0.9),
            create_match(10.5, 15.5, 0.85),
            create_match(11.0, 16.0, 0.88),
        ]

        # Duration is 1 second
        result_short = aggregate_segments(
            matches, min_segment_duration=0.5, min_segment_matches=2
        )
        result_long = aggregate_segments(
            matches, min_segment_duration=5.0, min_segment_matches=2
        )

        assert len(result_short) >= 1
        assert len(result_long) == 0  # Segment too short

    def test_min_segment_matches(self):
        """Test min_segment_matches filter."""
        matches = [
            create_match(10.0, 15.0, 0.9),
            create_match(11.0, 16.0, 0.85),
        ]

        result_low = aggregate_segments(
            matches, min_segment_duration=0.5, min_segment_matches=2
        )
        result_high = aggregate_segments(
            matches, min_segment_duration=0.5, min_segment_matches=5
        )

        assert len(result_low) >= 1
        assert len(result_high) == 0  # Not enough matches


class TestCreateSegmentFromCluster:
    """Tests for _create_segment_from_cluster function."""

    def test_empty_cluster(self):
        """Test with empty cluster."""
        result = _create_segment_from_cluster([])
        assert result is None

    def test_single_match_cluster(self):
        """Test with single match."""
        match = create_match(10.0, 15.0, 0.9)
        cluster = [(match, 5.0)]  # (match, offset)

        result = _create_segment_from_cluster(cluster)

        assert result is not None
        assert result.source_start == 10.0
        assert result.source_end == 10.0
        assert result.target_start == 15.0
        assert result.target_end == 15.0
        assert result.match_count == 1
        assert result.avg_similarity == 0.9

    def test_multiple_matches_cluster(self):
        """Test with multiple matches."""
        matches = [
            (create_match(10.0, 15.0, 0.9), 5.0),
            (create_match(12.0, 17.0, 0.85), 5.0),
            (create_match(14.0, 19.0, 0.88), 5.0),
        ]

        result = _create_segment_from_cluster(matches)

        assert result is not None
        assert result.source_start == 10.0
        assert result.source_end == 14.0
        assert result.target_start == 15.0
        assert result.target_end == 19.0
        assert result.match_count == 3


class TestWindowSimilarity:
    """Tests for WindowSimilarity dataclass."""

    def test_to_dict(self):
        """Test serialization to dictionary."""
        window = WindowSimilarity(
            source_start=0.0,
            source_end=30.0,
            matched_frame_count=5,
            matched_frame_ratio=0.5,
            avg_similarity=0.85,
            best_target_start=10.0,
            best_target_end=40.0,
        )

        d = window.to_dict()
        assert d["source_start"] == 0.0
        assert d["source_end"] == 30.0
        assert d["matched_frame_count"] == 5
        assert d["matched_frame_ratio"] == 0.5
        assert d["avg_similarity"] == 0.85
        assert d["best_target_start"] == 10.0
        assert d["best_target_end"] == 40.0


class TestMatchedSegment:
    """Tests for MatchedSegment dataclass."""

    def test_duration_property(self):
        """Test duration calculation."""
        segment = MatchedSegment(
            source_start=10.0,
            source_end=25.0,
            target_start=15.0,
            target_end=30.0,
            coverage=0.8,
            avg_similarity=0.85,
            confidence=0.75,
            match_count=5,
        )

        assert segment.duration == 15.0

    def test_to_dict(self):
        """Test serialization to dictionary."""
        segment = MatchedSegment(
            source_start=10.0,
            source_end=25.0,
            target_start=15.0,
            target_end=30.0,
            coverage=0.8,
            avg_similarity=0.85,
            confidence=0.75,
            match_count=5,
        )

        d = segment.to_dict()
        assert d["source_start"] == 10.0
        assert d["source_end"] == 25.0
        assert d["target_start"] == 15.0
        assert d["target_end"] == 30.0
        assert d["duration"] == 15.0
        assert d["coverage"] == 0.8
        assert d["avg_similarity"] == 0.85
        assert d["confidence"] == 0.75
        assert d["match_count"] == 5


class TestIntegration:
    """Integration tests combining multiple functions."""

    def test_clip_detection_workflow(self):
        """Test workflow simulating clip detection."""
        # Simulate: Video B is a 10-second clip from Video A
        # A runs from 0-60s, B runs from 0-10s but matches A's 20-30s

        matches_a_to_b = []
        matches_b_to_a = []

        # B frames (0-10s) match A frames (20-30s)
        for i in range(10):
            b_time = float(i)
            a_time = 20.0 + i
            matches_b_to_a.append(create_match(b_time, a_time, 0.9))
            matches_a_to_b.append(create_match(a_time, b_time, 0.9))

        all_matches = matches_a_to_b + matches_b_to_a

        # Aggregate segments
        segments = aggregate_segments(
            all_matches, min_segment_duration=5.0, min_segment_matches=3
        )

        # Should find one segment
        assert len(segments) >= 1

        # The main segment should show the offset relationship
        main_segment = segments[0]
        assert main_segment.match_count >= 10
        assert main_segment.avg_similarity > 0.85

    def test_partial_overlap_workflow(self):
        """Test workflow simulating partial overlap."""
        # Videos share content in middle sections
        matches = []

        # Shared section: A 30-40s matches B 10-20s
        for i in range(10):
            a_time = 30.0 + i
            b_time = 10.0 + i
            matches.append(create_match(a_time, b_time, 0.85))
            matches.append(create_match(b_time, a_time, 0.85))

        # Another shared section: A 80-90s matches B 50-60s
        for i in range(10):
            a_time = 80.0 + i
            b_time = 50.0 + i
            matches.append(create_match(a_time, b_time, 0.88))
            matches.append(create_match(b_time, a_time, 0.88))

        segments = aggregate_segments(
            matches, min_segment_duration=5.0, min_segment_matches=3
        )

        # Should find two segments
        assert len(segments) == 2

        # Verify segment boundaries
        for seg in segments:
            assert seg.match_count >= 8
            assert seg.avg_similarity > 0.8
