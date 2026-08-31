"""Golden cases for direction-aware temporal segment aggregation."""

import pytest

from video_sim.matcher import FrameMatch, _temporal_consistent_coverage
from video_sim.segmenter import (
    MatchedSegment,
    _fuse_directional_segments,
    aggregate_bidirectional_segments,
    aggregate_segments,
    fixed_window_similarity,
)


def make_match(source, target, index=None, similarity=0.92):
    index = int(source if index is None else index)
    return FrameMatch(
        source_video="a.mp4",
        target_video="b.mp4",
        source_frame_index=index,
        target_frame_index=int(target * 10),
        source_timestamp=float(source),
        target_timestamp=float(target),
        similarity=similarity,
    )


def test_fixed_offset_and_real_sparse_timeline_coverage():
    matches = [make_match(value, value + 5, index) for index, value in enumerate((0, 20, 40))]
    segments = aggregate_segments(
        matches,
        source_timestamps=[0, 10, 20, 30, 40, 50],
        total_source_duration=50,
        min_segment_duration=5,
        min_segment_matches=3,
    )
    assert len(segments) == 1
    assert segments[0].source_start == 0
    assert segments[0].source_end == 40
    assert 0.0 < segments[0].coverage < 1.0

    windows = fixed_window_similarity(
        matches,
        window_size=20,
        source_timestamps=[0, 10, 20, 30, 40, 50],
        total_source_duration=50,
    )
    # The 20s source sample's midpoint cell is [15,25], so its [15,20]
    # intersection contributes to the first window.  The ratio is exactly
    # one half after clipping and cross-window cell accounting.
    assert windows[0].matched_frame_ratio == pytest.approx(0.5)


def test_timestamp_coverage_is_not_biased_by_sampling_density():
    dense_timeline = list(range(101))
    dense_matches = [make_match(value, value + 5, index) for index, value in enumerate(range(20, 81))]
    sparse_timeline = list(range(0, 101, 10))
    sparse_matches = [make_match(value, value + 5, index) for index, value in enumerate(range(20, 81, 10))]
    dense = _temporal_consistent_coverage(
        dense_matches,
        total_source_frames=len(dense_timeline),
        source_timestamps=dense_timeline,
        total_source_duration=100,
        target_timestamps=dense_timeline,
        total_target_duration=100,
    )
    sparse = _temporal_consistent_coverage(
        sparse_matches,
        total_source_frames=len(sparse_timeline),
        source_timestamps=sparse_timeline,
        total_source_duration=100,
        target_timestamps=sparse_timeline,
        total_target_duration=100,
    )
    assert 0.5 < dense < 0.8
    assert 0.5 < sparse < 0.8
    assert abs(dense - sparse) < 0.15


def test_fixed_windows_include_unmatched_leading_source_time():
    windows = fixed_window_similarity(
        [make_match(12, 17, 12)],
        window_size=10,
        source_timestamps=list(range(31)),
        total_source_duration=30,
    )
    assert [window.source_start for window in windows[:2]] == [0, 10]
    assert windows[0].matched_frame_count == 0
    assert windows[1].matched_frame_count == 1


def test_same_offset_disjoint_ranges_remain_two_segments():
    values = (0, 1, 2, 50, 51, 52)
    segments = aggregate_segments(
        [make_match(value, value + 8, index) for index, value in enumerate(values)],
        min_segment_duration=1,
        min_segment_matches=3,
    )
    assert len(segments) == 2
    assert {(segment.source_start, segment.source_end) for segment in segments} == {
        (0, 2),
        (50, 52),
    }


def test_different_offsets_and_bidirectional_normalization():
    first = [make_match(value, value + 5, index) for index, value in enumerate((0, 1, 2))]
    second = [make_match(value, value + 30, index + 10) for index, value in enumerate((20, 21, 22))]
    assert len(aggregate_segments(first + second, min_segment_duration=1, min_segment_matches=3)) == 2

    ab = [make_match(value, value + 10, index) for index, value in enumerate((10, 11, 12, 13, 14))]
    ba = [make_match(value + 10, value, index) for index, value in enumerate((10, 11, 12, 13, 14))]
    fused = aggregate_bidirectional_segments(
        ab,
        ba,
        min_segment_duration=3,
        min_segment_matches=3,
    )
    assert len(fused) == 1
    assert (fused[0].source_start, fused[0].source_end) == (10, 14)
    assert (fused[0].target_start, fused[0].target_end) == (20, 24)


def test_complete_timeline_gap_prevents_sparse_matches_from_becoming_one_segment():
    sparse_matches = [make_match(value, value + 5, index) for index, value in enumerate((0, 50, 100))]
    dense_timeline = list(range(101))
    assert aggregate_segments(
        sparse_matches,
        source_timestamps=dense_timeline,
        total_source_duration=100,
        target_timestamps=dense_timeline,
        total_target_duration=100,
        min_segment_duration=5,
        min_segment_matches=3,
    ) == []


def test_uneven_sampling_short_clip_and_multiple_clusters_are_stable():
    values = (0.0, 0.4, 1.9, 5.0, 9.0)
    matches = [make_match(value, value + 3, index) for index, value in enumerate(values)]
    segments = aggregate_segments(matches, min_segment_duration=1, min_segment_matches=3)
    assert len(segments) == 1
    assert segments[0].match_count == len(values)

    short = aggregate_segments(
        [make_match(value, value + 2, index) for index, value in enumerate((0.0, 0.5, 1.0))],
        min_segment_duration=0.5,
        min_segment_matches=3,
    )
    assert len(short) == 1

    disjoint = [make_match(value, value + 4, index) for index, value in enumerate((0, 1, 2, 50, 51, 52))]
    coverage = _temporal_consistent_coverage(disjoint, total_source_frames=12)
    assert 0.45 < coverage < 0.6


def test_jitter_and_mild_speed_change_are_allowed_but_random_order_is_rejected():
    smooth = [
        make_match(value, 5.0 + value * 1.05 + (0.08 if index % 2 else -0.08), index)
        for index, value in enumerate(range(9))
    ]
    segments = aggregate_segments(
        smooth,
        min_segment_duration=5,
        min_segment_matches=3,
        offset_tolerance_sec=1.0,
    )
    assert len(segments) == 1
    assert segments[0].match_count == 9

    random_targets = (20, 0, 19, 1, 18, 2, 17, 3, 16, 4, 15, 5)
    random_matches = [make_match(index, target, index) for index, target in enumerate(random_targets)]
    assert _temporal_consistent_coverage(random_matches, total_source_frames=12) == 0.0
    assert aggregate_segments(random_matches, min_segment_duration=2, min_segment_matches=3) == []


def test_affine_trend_allows_long_speed_change_and_missing_matches():
    timeline = list(range(101))
    long_matches = [make_match(value, 5.0 + value * 1.05, index) for index, value in enumerate(timeline)]
    missing_values = [value for value in timeline if value not in {20, 21, 55, 56, 90}]
    missing_matches = [make_match(value, 5.0 + value * 1.05, index) for index, value in enumerate(missing_values)]
    for matches in (long_matches, missing_matches):
        segments = aggregate_segments(
            matches,
            source_timestamps=timeline,
            total_source_duration=100,
            target_timestamps=[5.0 + value * 1.05 for value in timeline],
            total_target_duration=110,
            min_segment_duration=5,
            min_segment_matches=3,
        )
        assert len(segments) == 1
        assert segments[0].source_end == 100


def test_directional_fusion_requires_both_coordinate_ranges_to_overlap():
    base = MatchedSegment(10, 20, 30, 40, 0.8, 0.9, 0.9, 10)
    source_only = MatchedSegment(11, 19, 100, 110, 0.8, 0.9, 0.9, 10)
    target_only = MatchedSegment(100, 110, 31, 39, 0.8, 0.9, 0.9, 10)
    slight = MatchedSegment(10.5, 20.5, 30.5, 40.5, 0.8, 0.9, 0.9, 10)
    assert len(_fuse_directional_segments([base, source_only])) == 2
    assert len(_fuse_directional_segments([base, target_only])) == 2
    assert len(_fuse_directional_segments([base, slight])) == 1
