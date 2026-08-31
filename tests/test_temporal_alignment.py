"""Regression cases for bounded, multi-track temporal alignment."""

import pytest

from video_sim.matcher import FrameMatch, _determine_relation, _temporal_consistent_coverage
from video_sim.temporal_alignment import align_matches
from video_sim.segmenter import fixed_window_similarity


def make_match(source, target, source_index=None, target_index=None, similarity=0.99):
    return FrameMatch(
        source_video="a.mp4",
        target_video="b.mp4",
        source_frame_index=int(source if source_index is None else source_index),
        target_frame_index=int(target if target_index is None else target_index),
        source_timestamp=float(source),
        target_timestamp=float(target),
        similarity=float(similarity),
    )


def test_multiple_valid_tracks_do_not_cancel_each_other():
    matches = [
        candidate
        for index in range(20)
        for candidate in (
            make_match(index, index + 30, index, index + 30),
            make_match(index, index + 130, index, index + 130, similarity=0.98),
        )
    ]

    alignment = align_matches(
        matches,
        total_source_frames=20,
        source_timestamps=list(range(20)),
        total_source_duration=20,
        target_timestamps=list(range(30, 150)),
        total_target_duration=150,
    )

    assert len(alignment.tracks) == 2
    assert len(alignment.verified_matches) == 40
    assert _temporal_consistent_coverage(
        alignment.verified_matches,
        total_source_frames=20,
        source_timestamps=list(range(20)),
        total_source_duration=20,
        target_timestamps=list(range(30, 150)),
        total_target_duration=150,
    ) == pytest.approx(1.0)


def test_repeated_target_cluster_does_not_prove_whole_source():
    matches = [
        make_match(source, target, source, target)
        for source in range(0, 100, 5)
        for target in range(3)
    ]
    alignment = align_matches(
        matches,
        total_source_frames=20,
        source_timestamps=list(range(0, 100, 5)),
        total_source_duration=100,
        target_timestamps=list(range(3)),
        total_target_duration=3,
    )

    assert alignment.verified_matches == []
    assert alignment.evidence["rejected_weak_tracks"] >= 1


def test_long_static_source_can_reuse_one_target_frame_with_strong_evidence():
    """A static shot is a controlled many-to-one, not a forced singleton."""

    source_timestamps = [float(value) for value in range(0, 100, 5)]
    matches = [
        make_match(source, 0.0, source_index=index, target_index=0, similarity=0.99)
        for index, source in enumerate(source_timestamps)
    ]

    alignment = align_matches(
        matches,
        total_source_frames=len(source_timestamps),
        source_timestamps=source_timestamps,
        total_source_duration=100.0,
        target_timestamps=[0.0],
        total_target_duration=1.0,
    )

    assert len(alignment.tracks) == 1
    assert len(alignment.tracks[0]) == len(source_timestamps)
    assert alignment.source_coverage == pytest.approx(1.0)


def test_duration_without_complete_timeline_uses_frame_evidence_fallback():
    matches = [make_match(source, source + 5.0, source_index=index) for index, source in enumerate((0.0, 1.0, 2.0))]

    alignment = align_matches(
        matches,
        total_source_frames=10,
        total_source_duration=100.0,
    )

    # A duration is not a license to treat the three observed timestamps as a
    # complete timeline; only three of ten independent source frames are
    # evidenced when the complete timestamp list is unavailable.
    assert alignment.source_coverage == pytest.approx(0.3)


def test_max_track_cap_is_deterministic_and_reported():
    matches = [
        candidate
        for source in range(5)
        for candidate in (
            make_match(source, source + 10, source, source + 10),
            make_match(source, source + 30, source, source + 30, similarity=0.98),
            make_match(source, source + 50, source, source + 50, similarity=0.97),
        )
    ]
    kwargs = dict(
        total_source_frames=5,
        source_timestamps=list(range(5)),
        total_source_duration=5.0,
        target_timestamps=list(range(10, 15)) + list(range(30, 35)) + list(range(50, 55)),
        total_target_duration=55.0,
        max_tracks=2,
    )

    first = align_matches(matches, **kwargs)
    shuffled = align_matches(list(reversed(matches)), **kwargs)

    assert len(first.tracks) == 2
    assert first.evidence["max_tracks"] == 2
    assert first.evidence["tracks_truncated"] is True
    assert [
        [(item.source_timestamp, item.target_timestamp) for item in track]
        for track in first.tracks
    ] == [
        [(item.source_timestamp, item.target_timestamp) for item in track]
        for track in shuffled.tracks
    ]
    assert first.evidence == shuffled.evidence


def test_equal_reliable_duration_does_not_use_sampling_density_for_relation():
    assert _determine_relation(1.0, 1.0, 200, 100, 60.0, 60.0) == "near_duplicate_or_same_content"


def test_window_tail_is_clipped_and_cross_cell_time_is_split():
    matches = [make_match(0, 5), make_match(20, 25)]
    windows = fixed_window_similarity(
        matches,
        window_size=20,
        source_timestamps=[0, 10, 20, 30, 40, 50],
        total_source_duration=50,
    )

    assert [(window.source_start, window.source_end) for window in windows] == [
        (0, 20),
        (20, 40),
        (40, 50),
    ]
    assert windows[0].matched_frame_ratio == pytest.approx(0.5)
    assert windows[-1].matched_frame_ratio == pytest.approx(0.0)
