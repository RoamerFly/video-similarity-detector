"""Focused tests for the optional decode-only segment refiner."""

from __future__ import annotations

import copy
from collections.abc import Sequence

import numpy as np
import pytest

pytest.importorskip("cv2")

from video_sim.segment_refiner import (
    MAX_REFINEMENT_FRAMES,
    MAX_REFINEMENT_INPUT_SEGMENTS,
    MAX_REFINEMENT_SEGMENTS,
    MIN_TRANSITION_COSINE,
    RefinementConfig,
    SEGMENT_REFINEMENT_VERSION,
    _Interval,
    _candidate_times,
    _close_reader,
    refinement_failure_payload,
    refine_segments,
)


def _moving_frame(timestamp: float, *, phase: float = 0.0) -> np.ndarray:
    """A textured frame with a visible, deterministic moving foreground."""

    height = width = 64
    y, x = np.indices((height, width))
    frame = np.stack(
        (
            (x * 3 + y * 5) % 251,
            (x * 7 + y * 2) % 251,
            (x * 11 + y * 13) % 251,
        ),
        axis=-1,
    ).astype(np.uint8)
    position = int(round((timestamp + phase) * 20.0)) % 40
    frame[16:48, position : position + 20] = (250, 20, 230)
    return frame


class _Reader:
    width = 64
    height = 64
    fps = 25.0
    frame_count = 500
    duration = 20.0
    timestamp_basis = "injected_pts"

    def __init__(self, frame_fn):
        self.frame_fn = frame_fn
        self.calls = []
        self.closed = False

    def read_at(self, timestamp):
        self.calls.append(float(timestamp))
        return self.frame_fn(float(timestamp)), float(timestamp), self.timestamp_basis

    def close(self):
        self.closed = True


class _Factory:
    def __init__(self, readers):
        self.readers = list(readers)
        self.calls = 0

    def __call__(self, _path):
        reader = self.readers[self.calls]
        self.calls += 1
        return reader


def _clock():
    return 100.0


def _coarse_segment():
    return {
        "source_start": 2.0,
        "source_end": 4.0,
        "target_start": 5.0,
        "target_end": 7.0,
        "confidence": 0.98,
        "unknown": {"keep": True},
    }


def _copy_factory(offset=3.0):
    source = _Reader(lambda timestamp: _moving_frame(timestamp))
    target = _Reader(lambda timestamp: _moving_frame(timestamp - offset))
    return _Factory([source, target]), source, target


def test_off_returns_before_iterating_segments_or_opening_media():
    calls = []

    def bad_segments():
        calls.append("segments")
        raise AssertionError("off mode must not consume segments")
        yield None

    def reader_factory(_path):
        calls.append("reader")
        raise AssertionError("off mode must not open a reader")

    assert (
        refine_segments(
            "a.mp4",
            "b.mp4",
            bad_segments(),
            config=RefinementConfig(mode="off"),
            reader_factory=reader_factory,
        )
        is None
    )
    assert calls == []


def test_config_is_versioned_and_rejects_non_finite_or_bool_values():
    config = RefinementConfig(mode="copy")
    assert config.to_dict()["version"] == SEGMENT_REFINEMENT_VERSION
    assert config.to_dict()["min_transition_cosine"] == MIN_TRANSITION_COSINE
    with pytest.raises(ValueError):
        RefinementConfig(sample_step_sec=float("nan"))
    with pytest.raises(TypeError):
        RefinementConfig(max_frames=True)
    with pytest.raises(ValueError):
        RefinementConfig(min_support=2)
    with pytest.raises(ValueError):
        RefinementConfig(pixel_threshold=1.1)


@pytest.mark.parametrize(
    ("field", "limit"),
    [
        ("max_frames", MAX_REFINEMENT_FRAMES),
        ("max_segments", MAX_REFINEMENT_SEGMENTS),
    ],
)
def test_config_rejects_values_above_hard_resource_ceiling(field, limit):
    with pytest.raises(ValueError, match=rf"{field} must be <= {limit}"):
        RefinementConfig(**{field: limit + 1})


def test_segments_must_be_a_bounded_sequence_for_enabled_refinement():
    generator = (_coarse_segment() for _ in range(1))
    with pytest.raises(TypeError, match="finite Sequence"):
        refine_segments(
            "source.mp4",
            "target.mp4",
            generator,
            config=RefinementConfig(mode="copy"),
        )
    with pytest.raises(TypeError, match="finite Sequence"):
        refinement_failure_payload(
            generator,
            config=RefinementConfig(mode="copy"),
            reason="test",
        )


@pytest.mark.parametrize("segments", ["not-segments", b"not-segments"])
def test_text_segments_are_rejected(segments):
    with pytest.raises(TypeError, match="finite Sequence"):
        refine_segments(
            "source.mp4",
            "target.mp4",
            segments,
            config=RefinementConfig(mode="copy"),
        )


def test_oversized_sequence_is_rejected_before_iteration_but_off_stays_zero_io():
    class HugeSequence(Sequence):
        def __len__(self):
            return MAX_REFINEMENT_INPUT_SEGMENTS + 1

        def __getitem__(self, _index):
            raise AssertionError("oversized sequence must be rejected by length")

    huge = HugeSequence()
    with pytest.raises(ValueError, match=rf"segments length must be <= {MAX_REFINEMENT_INPUT_SEGMENTS}"):
        refine_segments(
            "source.mp4",
            "target.mp4",
            huge,
            config=RefinementConfig(mode="copy"),
        )
    assert (
        refine_segments(
            "source.mp4",
            "target.mp4",
            huge,
            config=RefinementConfig(mode="off"),
        )
        is None
    )


def test_candidate_time_dedup_keeps_center_first_and_boundary_behavior():
    values = _candidate_times(
        0.05,
        _Interval(0.0, 0.1),
        radius=0.5,
        step=0.1,
        max_candidates=32,
    )
    assert values[0] == 0.05
    assert values == [0.05, 0.0, 0.1]


def test_close_failure_falls_back_to_release():
    calls = []

    class Reader:
        def close(self):
            calls.append("close")
            raise RuntimeError("close failed")

        def release(self):
            calls.append("release")

    _close_reader(Reader())
    assert calls == ["close", "release"]


def test_known_boundary_is_verified_without_changing_coarse_input():
    factory, source, target = _copy_factory()
    coarse = _coarse_segment()
    original = copy.deepcopy(coarse)
    result = refine_segments(
        "source.mp4",
        "target.mp4",
        [coarse],
        config=RefinementConfig(mode="copy", padding_sec=0.5, max_frames=128),
        reader_factory=factory,
        clock=_clock,
    )

    assert result["version"] == SEGMENT_REFINEMENT_VERSION
    item = result["segments"][0]
    assert item["status"] == "verified"
    assert item["proposal"] is not None
    assert item["proposal"]["source_start"] < 2.0
    assert item["proposal"]["source_end"] > 4.0
    assert item["proposal"]["target_start"] < 5.0
    assert item["proposal"]["target_end"] > 7.0
    assert item["proposal_adoptable"] is True
    assert coarse == original
    assert source.closed and target.closed
    assert result["metrics"]["frame_attempts"] == len(source.calls) + len(target.calls)
    assert item["evidence"]["timestamp_basis"] == {
        "source": "injected_pts",
        "target": "injected_pts",
    }


def test_mirror_mode_selects_one_consistent_direction_for_the_whole_segment():
    source = _Reader(lambda timestamp: _moving_frame(timestamp))
    target = _Reader(
        lambda timestamp: np.flip(_moving_frame(timestamp - 3.0), axis=1).copy()
    )
    result = refine_segments(
        "source.mp4",
        "target.mp4",
        [_coarse_segment()],
        config=RefinementConfig(
            mode="copy-mirror", padding_sec=0.5, max_frames=220
        ),
        reader_factory=_Factory([source, target]),
        clock=_clock,
    )

    item = result["segments"][0]
    assert item["status"] == "verified"
    assert item["evidence"]["direction"] == "mirror"
    assert item["evidence"]["consistent_transition_count"] >= 2


def test_mirror_mode_does_not_turn_time_reversal_into_a_copy():
    source = _Reader(lambda timestamp: _moving_frame(timestamp))
    target = _Reader(
        lambda timestamp: np.flip(_moving_frame(4.0 - (timestamp - 5.0)), axis=1).copy()
    )
    result = refine_segments(
        "source.mp4",
        "target.mp4",
        [_coarse_segment()],
        config=RefinementConfig(mode="copy-mirror", padding_sec=0.5, max_frames=220),
        reader_factory=_Factory([source, target]),
        clock=_clock,
    )

    assert result["segments"][0]["status"] != "verified"


def test_static_template_is_insufficient_even_when_pixels_match():
    static = np.zeros((64, 64, 3), dtype=np.uint8)
    static[8:56, 12:52] = (50, 110, 210)
    source = _Reader(lambda _timestamp: static.copy())
    target = _Reader(lambda _timestamp: static.copy())
    result = refine_segments(
        "source.mp4",
        "target.mp4",
        [_coarse_segment()],
        config=RefinementConfig(mode="copy", padding_sec=0.5, max_frames=128),
        reader_factory=_Factory([source, target]),
        clock=_clock,
    )

    item = result["segments"][0]
    assert item["status"] == "insufficient_evidence"
    assert item["reason"] == "insufficient_temporal_change"
    assert item["evidence"]["mean_score"] >= 0.92


def test_shared_template_with_different_motion_does_not_verify():
    source = _Reader(lambda timestamp: _moving_frame(timestamp, phase=0.0))
    # The foreground moves in the opposite phase, while most of the frame is
    # deliberately shared.  Pixel similarity alone must not certify this.
    target = _Reader(lambda timestamp: _moving_frame(-(timestamp - 3.0), phase=0.0))
    result = refine_segments(
        "source.mp4",
        "target.mp4",
        [_coarse_segment()],
        config=RefinementConfig(mode="copy", padding_sec=0.5, max_frames=128),
        reader_factory=_Factory([source, target]),
        clock=_clock,
    )

    assert result["segments"][0]["status"] != "verified"


def test_partial_local_support_never_proposes_shrinking_the_coarse_segment():
    source = _Reader(lambda timestamp: _moving_frame(timestamp))

    class PartialReader(_Reader):
        def read_at(self, timestamp):
            if 5.5 <= float(timestamp) <= 6.5:
                return super().read_at(timestamp)
            return np.zeros((64, 64, 3), dtype=np.uint8), float(timestamp), self.timestamp_basis

    target = PartialReader(lambda timestamp: _moving_frame(timestamp - 3.0))
    result = refine_segments(
        "source.mp4",
        "target.mp4",
        [_coarse_segment()],
        config=RefinementConfig(
            mode="copy", padding_sec=0.5, search_radius_sec=0.0, max_frames=128
        ),
        reader_factory=_Factory([source, target]),
        clock=_clock,
    )

    item = result["segments"][0]
    assert item["status"] == "insufficient_evidence"
    assert item["reason"] == "local_support_does_not_cover_coarse"
    assert item["proposal"] is None
    assert item["proposal_adoptable"] is False
    assert "local_verified_interval" in item["evidence"]


def test_pair_frame_budget_counts_failed_reads_and_never_overshoots():
    factory, source, target = _copy_factory()
    result = refine_segments(
        "source.mp4",
        "target.mp4",
        [_coarse_segment(), _coarse_segment()],
        config=RefinementConfig(mode="copy", max_frames=3, padding_sec=0.5),
        reader_factory=factory,
        clock=_clock,
    )

    assert result["metrics"]["frame_attempts"] <= 3
    assert result["segments"][0]["status"] == "budget_exceeded"
    assert result["segments"][1]["status"] == "budget_exceeded"
    assert result["segments"][1]["reason"] == "max_frames"


def test_tiny_step_and_long_interval_are_rejected_before_timestamp_list_creation():
    factory, source, target = _copy_factory()
    result = refine_segments(
        "source.mp4",
        "target.mp4",
        [{"source_start": 0.0, "source_end": 20.0, "target_start": 0.0, "target_end": 20.0}],
        config=RefinementConfig(
            mode="copy", sample_step_sec=1e-300, max_frames=16, padding_sec=0
        ),
        reader_factory=factory,
        clock=_clock,
    )
    assert result["segments"][0]["status"] == "budget_exceeded"
    assert result["segments"][0]["reason"] == "max_frames"
    assert result["metrics"]["frame_attempts"] == 0


def test_target_actual_timestamp_gap_splits_support_run():
    source = _Reader(lambda timestamp: _moving_frame(timestamp))

    class GapReader(_Reader):
        def __init__(self):
            super().__init__(lambda timestamp: _moving_frame(timestamp - 3.0))
            self.read_count = 0

        def read_at(self, timestamp):
            self.read_count += 1
            frame = self.frame_fn(float(timestamp))
            # Keep the first four points contiguous, then make the actual PTS
            # jump by one second while remaining inside the local target span.
            actual = float(timestamp) + (1.0 if self.read_count >= 5 else 0.0)
            return frame, actual, self.timestamp_basis

    target = GapReader()
    result = refine_segments(
        "source.mp4",
        "target.mp4",
        [_coarse_segment()],
        config=RefinementConfig(
            mode="copy",
            padding_sec=0.0,
            min_support=5,
            max_frames=128,
        ),
        reader_factory=_Factory([source, target]),
        clock=_clock,
    )
    item = result["segments"][0]
    assert item["status"] == "insufficient_evidence"
    assert item["reason"] == "insufficient_continuous_support"


def test_low_scoring_padding_point_does_not_block_later_actual_support():
    source = _Reader(lambda timestamp: _moving_frame(timestamp))

    class PaddingReader(_Reader):
        def read_at(self, timestamp):
            # The first padded target cell is unrelated and has a valid PTS.
            if float(timestamp) < 5.0:
                return np.zeros((64, 64, 3), dtype=np.uint8), float(timestamp), self.timestamp_basis
            return super().read_at(timestamp)

    target = PaddingReader(lambda timestamp: _moving_frame(timestamp - 3.0))
    result = refine_segments(
        "source.mp4",
        "target.mp4",
        [_coarse_segment()],
        config=RefinementConfig(mode="copy", padding_sec=0.5, max_frames=128),
        reader_factory=_Factory([source, target]),
        clock=_clock,
    )
    item = result["segments"][0]
    assert item["status"] == "verified"
    support = item["evidence"]["support_points"]
    assert min(point["source_timestamp"] for point in support) >= 1.75


def test_invalid_bounds_are_safe_and_do_not_decode():
    factory, source, target = _copy_factory()
    segments = [
        {"source_start": float("nan"), "source_end": 4.0, "target_start": 5.0, "target_end": 7.0},
        {"source_start": -5.0, "source_end": -1.0, "target_start": 5.0, "target_end": 7.0},
    ]
    result = refine_segments(
        "source.mp4",
        "target.mp4",
        segments,
        config=RefinementConfig(mode="copy"),
        reader_factory=factory,
        clock=_clock,
    )

    assert all(item["status"] == "insufficient_evidence" for item in result["segments"])
    assert not source.calls and not target.calls
    assert result["segments"][0]["coarse"]["source_start"] is None


def test_second_reader_open_failure_closes_the_first_reader():
    source = _Reader(lambda timestamp: _moving_frame(timestamp))
    calls = [0]

    def factory(_path):
        calls[0] += 1
        if calls[0] == 1:
            return source
        raise OSError("broken target")

    result = refine_segments(
        "source.mp4",
        "target.mp4",
        [_coarse_segment()],
        config=RefinementConfig(mode="copy"),
        reader_factory=factory,
        clock=_clock,
    )
    assert result["segments"][0]["status"] == "decode_error"
    assert source.closed


def test_reader_is_closed_when_cancellation_propagates():
    factory, source, target = _copy_factory()
    calls = [0]

    def cancel():
        calls[0] += 1
        if calls[0] >= 4:
            raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        refine_segments(
            "source.mp4",
            "target.mp4",
            [_coarse_segment()],
            config=RefinementConfig(mode="copy"),
            reader_factory=factory,
            cancel_check=cancel,
            clock=_clock,
        )
    assert source.closed and target.closed


def test_segments_over_max_segments_are_returned_with_status():
    factory, source, target = _copy_factory()
    result = refine_segments(
        "source.mp4",
        "target.mp4",
        [_coarse_segment(), _coarse_segment()],
        config=RefinementConfig(mode="copy", max_segments=1, max_frames=2),
        reader_factory=factory,
        clock=_clock,
    )

    assert result["segments"][1]["segment_index"] == 1
    assert result["segments"][1]["status"] == "budget_exceeded"
    assert result["segments"][1]["reason"] == "max_segments"
