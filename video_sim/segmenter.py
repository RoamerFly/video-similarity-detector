"""
Video segment analysis module for video similarity search.

Provides time window similarity analysis and segment aggregation
for frame-level match results.
"""

from dataclasses import dataclass
from statistics import median
from typing import Dict, List, Optional, Sequence, Tuple

import math

from video_sim.matcher import FrameMatch


# Segment clustering constants are intentionally centralized.  They describe
# temporal continuity, not visual similarity thresholds.
DEFAULT_SEGMENT_GAP_SEC = 10.0
SEGMENT_GAP_MULTIPLIER = 3.0
TARGET_TIME_JITTER_SEC = 1.0
MIN_TEMPORAL_SLOPE = 0.65
MAX_TEMPORAL_SLOPE = 1.5
TEMPORAL_RESIDUAL_TOLERANCE_SEC = 2.0
SEGMENT_FUSION_IOU = 0.35
SEGMENT_FUSION_TOLERANCE_SEC = 2.0


@dataclass
class WindowSimilarity:
    """Similarity statistics for a time window."""

    source_start: float
    source_end: float
    matched_frame_count: int
    matched_frame_ratio: float
    avg_similarity: float
    best_target_start: float
    best_target_end: float

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "source_start": self.source_start,
            "source_end": self.source_end,
            "matched_frame_count": self.matched_frame_count,
            "matched_frame_ratio": self.matched_frame_ratio,
            "avg_similarity": self.avg_similarity,
            "best_target_start": self.best_target_start,
            "best_target_end": self.best_target_end,
        }


@dataclass
class MatchedSegment:
    """Aggregated segment of consecutive matches."""

    source_start: float
    source_end: float
    target_start: float
    target_end: float
    coverage: float
    avg_similarity: float
    confidence: float
    match_count: int

    @property
    def duration(self) -> float:
        """Duration of the segment in source video."""
        return self.source_end - self.source_start

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "source_start": self.source_start,
            "source_end": self.source_end,
            "target_start": self.target_start,
            "target_end": self.target_end,
            "duration": self.duration,
            "coverage": self.coverage,
            "avg_similarity": self.avg_similarity,
            "confidence": self.confidence,
            "match_count": self.match_count,
        }


def fixed_window_similarity(
    match_points: List[FrameMatch],
    window_size: float = 30.0,
    total_source_duration: Optional[float] = None,
    source_timestamps: Optional[Sequence[float]] = None,
    target_timestamps: Optional[Sequence[float]] = None,
    total_target_duration: Optional[float] = None,
) -> List[WindowSimilarity]:
    """
    Calculate similarity statistics for fixed time windows.

    Groups match points by source_timestamp into fixed-size windows
    and computes statistics for each window.

    Args:
        match_points: List of FrameMatch objects
        window_size: Window size in seconds (default: 30)
        total_source_duration: Total duration of source video (for last window)
        source_timestamps: Actual retained/sample timestamps from the source
            cache.  When supplied, coverage uses their time cells rather than
            assuming a fixed one-frame-per-second sampling rate.
        target_timestamps: Reserved for callers that keep both directional
            timelines; window coverage remains source-oriented.
        total_target_duration: Reserved for callers that keep both directional
            timelines; window coverage remains source-oriented.

    Returns:
        List of WindowSimilarity objects for each window
    """
    if not match_points:
        return []

    # Sort by source timestamp
    sorted_matches = sorted(match_points, key=lambda m: m.source_timestamp)
    timeline = _timeline_cells(
        source_timestamps if source_timestamps is not None else [
            m.source_timestamp for m in sorted_matches
        ],
        total_source_duration,
    )

    # Determine time range - a complete timeline must include unmatched
    # leading windows (for example, source 0..10 with the first match at 12s).
    # The target arguments are intentionally accepted for API symmetry.
    _ = target_timestamps, total_target_duration
    min_time = sorted_matches[0].source_timestamp
    if source_timestamps is not None:
        finite_source_times = [float(value) for value in source_timestamps if math.isfinite(float(value))]
        if finite_source_times:
            min_time = min(0.0, min(finite_source_times))
    max_time = sorted_matches[-1].source_timestamp
    if total_source_duration is not None:
        max_time = max(max_time, total_source_duration)

    # Ensure max_time > min_time so at least one window is created
    # For single match, create one window of window_size
    if max_time <= min_time:
        max_time = min_time + window_size

    # Create windows
    windows = []
    window_start = min_time
    match_cursor = 0

    while window_start < max_time:
        window_end = window_start + window_size

        # The matches are sorted once, so windows remain O(number of matches)
        # rather than rescanning the full list for every window.
        while (
            match_cursor < len(sorted_matches)
            and sorted_matches[match_cursor].source_timestamp < window_start
        ):
            match_cursor += 1
        window_cursor = match_cursor
        while (
            window_cursor < len(sorted_matches)
            and sorted_matches[window_cursor].source_timestamp < window_end
        ):
            window_cursor += 1
        window_matches = sorted_matches[match_cursor:window_cursor]
        match_cursor = window_cursor

        # Calculate statistics
        matched_count = len(window_matches)

        if window_matches:
            avg_sim = sum(m.similarity for m in window_matches) / len(window_matches)
            target_times = [m.target_timestamp for m in window_matches]
            best_target_start = min(target_times)
            best_target_end = max(target_times)
        else:
            avg_sim = 0.0
            best_target_start = 0.0
            best_target_end = 0.0

        # Measure the matched portion of the actual source timeline.  This is
        # deliberately duration based: a sparse sampler may retain one frame
        # every 20 seconds, while a cut-heavy source may retain many frames in
        # one second.
        matched_duration = _covered_duration(
            [m.source_timestamp for m in window_matches],
            timeline,
            window_start,
            window_end,
        )
        matched_ratio = matched_duration / max(window_size, 1e-9)

        windows.append(
            WindowSimilarity(
                source_start=window_start,
                source_end=window_end,
                matched_frame_count=matched_count,
                matched_frame_ratio=min(1.0, matched_ratio),
                avg_similarity=avg_sim,
                best_target_start=best_target_start,
                best_target_end=best_target_end,
            )
        )

        window_start = window_end

    return windows


def aggregate_segments(
    match_points: List[FrameMatch],
    min_segment_duration: float = 5.0,
    min_segment_matches: int = 3,
    offset_tolerance_sec: float = 3.0,
    source_timestamps: Optional[Sequence[float]] = None,
    total_source_duration: Optional[float] = None,
    max_source_gap_sec: Optional[float] = None,
    max_target_gap_sec: Optional[float] = None,
    target_timestamps: Optional[Sequence[float]] = None,
    total_target_duration: Optional[float] = None,
) -> List[MatchedSegment]:
    """
    Aggregate match points into contiguous segments.

    Groups matches with similar offsets (target - source) only while their
    source and target timelines remain contiguous and monotonic.  The source
    order is intentional: offset-only clustering would merge far-apart
    reused clips.

    Args:
        match_points: List of FrameMatch objects
        min_segment_duration: Minimum duration for a valid segment (seconds)
        min_segment_matches: Minimum number of matches for a valid segment
        offset_tolerance_sec: Maximum offset difference to consider matches as same segment
        source_timestamps: Actual source timeline used for coverage.
        total_source_duration: Optional source duration for timeline bounds.
        max_source_gap_sec: Optional continuity limit.  By default it is
            derived from the observed sampling interval.
        max_target_gap_sec: Optional target continuity limit.
        target_timestamps: Complete target timeline used for continuity.
        total_target_duration: Optional target duration metadata.

    Returns:
        List of MatchedSegment objects (deduplicated)
    """
    if not match_points:
        return []

    matches_with_offset = [
        (match, match.target_timestamp - match.source_timestamp)
        for match in match_points
    ]
    ordered = sorted(
        matches_with_offset,
        key=lambda item: (item[0].source_timestamp, item[0].target_timestamp),
    )
    source_gap = max_source_gap_sec or _observed_gap_limit(
        source_timestamps if source_timestamps is not None else [
            match.source_timestamp for match, _ in ordered
        ]
    )
    target_gap = max_target_gap_sec or _observed_gap_limit(
        target_timestamps if target_timestamps is not None else [
            match.target_timestamp for match, _ in ordered
        ]
    )

    # A single pass over source time preserves multiple disjoint reused clips,
    # unlike offset-only clustering which merged every clip with the same
    # offset.  Target monotonicity rejects semantically similar frames in a
    # random order without requiring an O(n^2) alignment matrix.
    clusters = _cluster_temporal_matches(
        ordered,
        offset_tolerance_sec=offset_tolerance_sec,
        source_gap_limit=source_gap,
        target_gap_limit=target_gap,
    )
    segments = []
    for cluster in clusters:
        if len(cluster) < min_segment_matches:
            continue
        segment = _create_segment_from_cluster(
            cluster,
            source_timestamps=source_timestamps,
            total_source_duration=total_source_duration,
        )
        # Filtering uses the actual sample-cell span, while public segment
        # boundaries remain the first/last matched timestamps for backwards
        # compatibility.  This keeps two sparse endpoint samples from being
        # discarded merely because their timestamp difference is one second.
        cluster_span = _cluster_timeline_span(
            cluster,
            source_timestamps=source_timestamps,
            total_source_duration=total_source_duration,
        )
        if segment and cluster_span >= min_segment_duration:
            segments.append(segment)

    # Compatibility fallback for callers that historically passed a mixed
    # list whose offsets alternate in source order.  It is deliberately only
    # used when the monotonic pass produced no valid segment; normal results
    # therefore retain the stricter temporal semantics above.
    if not segments and len(match_points) >= min_segment_matches * 2:
        offset_groups: List[List[Tuple[FrameMatch, float]]] = []
        offset_group_sum = 0.0
        for item in sorted(ordered, key=lambda value: value[1]):
            if not offset_groups:
                offset_groups.append([item])
                offset_group_sum = item[1]
                continue
            previous_offset = offset_group_sum / len(offset_groups[-1])
            if abs(item[1] - previous_offset) <= offset_tolerance_sec:
                offset_groups[-1].append(item)
                offset_group_sum += item[1]
            else:
                offset_groups.append([item])
                offset_group_sum = item[1]
        for offset_group in offset_groups:
            if len(offset_group) < min_segment_matches:
                continue
            for cluster in _cluster_temporal_matches(
                sorted(offset_group, key=lambda value: (value[0].source_timestamp, value[0].target_timestamp)),
                offset_tolerance_sec=offset_tolerance_sec,
                source_gap_limit=source_gap,
                target_gap_limit=target_gap,
            ):
                if len(cluster) < min_segment_matches:
                    continue
                segment = _create_segment_from_cluster(
                    cluster,
                    source_timestamps=source_timestamps,
                    total_source_duration=total_source_duration,
                )
                if segment and _cluster_timeline_span(
                    cluster,
                    source_timestamps=source_timestamps,
                    total_source_duration=total_source_duration,
                ) >= min_segment_duration:
                    segments.append(segment)

    # Deduplicate bidirectional segments (A→B and B→A)
    segments = _deduplicate_bidirectional_segments(segments)

    # Sort by confidence (descending)
    segments.sort(key=lambda s: s.confidence, reverse=True)

    return segments


def aggregate_bidirectional_segments(
    matches_a_to_b: List[FrameMatch],
    matches_b_to_a: List[FrameMatch],
    *,
    source_timestamps_a: Optional[Sequence[float]] = None,
    source_timestamps_b: Optional[Sequence[float]] = None,
    total_source_duration_a: Optional[float] = None,
    total_source_duration_b: Optional[float] = None,
    min_segment_duration: float = 5.0,
    min_segment_matches: int = 3,
    offset_tolerance_sec: float = 3.0,
) -> List[MatchedSegment]:
    """Aggregate each direction independently, then fuse A/B coordinates.

    ``FrameMatch.source_timestamp`` is relative to the direction in which it
    was produced.  Mixing A→B and B→A before clustering therefore creates
    invalid offsets and can make unrelated ranges look contiguous.  The
    reverse direction is normalized into A/B coordinates only after its own
    temporal clusters have been formed.
    """
    common = dict(
        min_segment_duration=min_segment_duration,
        min_segment_matches=min_segment_matches,
        offset_tolerance_sec=offset_tolerance_sec,
    )
    segments_ab = aggregate_segments(
        matches_a_to_b,
        source_timestamps=source_timestamps_a,
        total_source_duration=total_source_duration_a,
        target_timestamps=source_timestamps_b,
        total_target_duration=total_source_duration_b,
        **common,
    )
    segments_ba = aggregate_segments(
        matches_b_to_a,
        source_timestamps=source_timestamps_b,
        total_source_duration=total_source_duration_b,
        target_timestamps=source_timestamps_a,
        total_target_duration=total_source_duration_a,
        **common,
    )
    normalized_ba = [
        MatchedSegment(
            source_start=segment.target_start,
            source_end=segment.target_end,
            target_start=segment.source_start,
            target_end=segment.source_end,
            coverage=segment.coverage,
            avg_similarity=segment.avg_similarity,
            confidence=segment.confidence,
            match_count=segment.match_count,
        )
        for segment in segments_ba
    ]
    return _fuse_directional_segments(segments_ab + normalized_ba)


def _observed_gap_limit(timestamps: Sequence[float]) -> float:
    """Return a continuity gap derived from the observed timeline."""
    finite = sorted(float(value) for value in timestamps if math.isfinite(float(value)))
    gaps = [
        right - left
        for left, right in zip(finite, finite[1:])
        if right > left
    ]
    # The floor handles normal one-second sampling.  Multiplying the median
    # lets sparse, intentionally dynamic sampling remain one segment.
    return max(DEFAULT_SEGMENT_GAP_SEC, SEGMENT_GAP_MULTIPLIER * (median(gaps) if gaps else 0.0))


def _cluster_temporal_matches(
    ordered: Sequence[Tuple[FrameMatch, float]],
    *,
    offset_tolerance_sec: float,
    source_gap_limit: float,
    target_gap_limit: float,
) -> List[List[Tuple[FrameMatch, float]]]:
    clusters: List[List[Tuple[FrameMatch, float]]] = []
    current: List[Tuple[FrameMatch, float]] = []
    current_offset_sum = 0.0
    current_offset_count = 0
    first_source = None
    first_target = None
    regression = _OnlineAffineTrend()
    previous_source = None
    previous_target = None
    for match, offset in ordered:
        if not current:
            current = [(match, offset)]
            current_offset_sum = offset
            current_offset_count = 1
            first_source = match.source_timestamp
            first_target = match.target_timestamp
            regression = _OnlineAffineTrend()
            regression.add(match.source_timestamp, match.target_timestamp)
            previous_source = match.source_timestamp
            previous_target = match.target_timestamp
            continue
        source_delta = match.source_timestamp - float(previous_source)
        target_delta = match.target_timestamp - float(previous_target)
        current_offset = current_offset_sum / max(1, current_offset_count)
        contiguous = (
            0.0 <= source_delta <= source_gap_limit
            and -TARGET_TIME_JITTER_SEC <= target_delta <= target_gap_limit
            and (current_offset_count < 2 or abs(offset - current_offset) <= offset_tolerance_sec)
        )
        # Repeated target timestamps are valid for static shots and for a
        # shorter clip sampled more sparsely than the source.  Keep the
        # monotonic target check above, but defer affine slope validation until
        # the target advances by more than the jitter allowance.
        if contiguous and source_delta > 1e-6:
            if target_delta <= TARGET_TIME_JITTER_SEC:
                contiguous = source_delta <= max(1.5, target_delta * 1.5)
            else:
                candidate_slope = (match.target_timestamp - float(first_target)) / (
                    match.source_timestamp - float(first_source)
                )
                contiguous = (
                    MIN_TEMPORAL_SLOPE <= candidate_slope <= MAX_TEMPORAL_SLOPE
                    and abs(regression.residual(match.source_timestamp, match.target_timestamp))
                    <= TEMPORAL_RESIDUAL_TOLERANCE_SEC
                )
        if contiguous:
            current.append((match, offset))
            current_offset_sum += offset
            current_offset_count += 1
            regression.add(match.source_timestamp, match.target_timestamp)
        else:
            clusters.append(current)
            current = [(match, offset)]
            current_offset_sum = offset
            current_offset_count = 1
            first_source = match.source_timestamp
            first_target = match.target_timestamp
            regression = _OnlineAffineTrend()
            regression.add(match.source_timestamp, match.target_timestamp)
        previous_source = match.source_timestamp
        previous_target = match.target_timestamp
    if current:
        clusters.append(current)
    return clusters


class _OnlineAffineTrend:
    """Constant-memory online affine trend for one temporal cluster."""

    def __init__(self) -> None:
        self.count = 0
        self.sum_x = 0.0
        self.sum_y = 0.0
        self.sum_xx = 0.0
        self.sum_xy = 0.0

    def add(self, x: float, y: float) -> None:
        self.count += 1
        self.sum_x += x
        self.sum_y += y
        self.sum_xx += x * x
        self.sum_xy += x * y

    def parameters(self) -> Tuple[float, float]:
        denominator = self.count * self.sum_xx - self.sum_x * self.sum_x
        if self.count < 2 or abs(denominator) < 1e-9:
            mean_x = self.sum_x / max(1, self.count)
            mean_y = self.sum_y / max(1, self.count)
            return 1.0, mean_y - mean_x
        slope = (self.count * self.sum_xy - self.sum_x * self.sum_y) / denominator
        intercept = (self.sum_y - slope * self.sum_x) / self.count
        return slope, intercept

    def residual(self, x: float, y: float) -> float:
        slope, intercept = self.parameters()
        return y - (slope * x + intercept)


def _timeline_cells(
    timestamps: Optional[Sequence[float]],
    total_duration: Optional[float] = None,
) -> Dict[float, Tuple[float, float]]:
    """Build midpoint cells around real retained timestamps.

    A timestamp represents the interval halfway to its neighboring samples.
    This avoids treating a retained-frame count as a one-Hz frame rate while
    remaining stable for both dense and sparse dynamic sampling.
    """
    raw_values = [] if timestamps is None else timestamps
    values = sorted(
        {
            float(value)
            for value in raw_values
            if math.isfinite(float(value))
        }
    )
    if not values:
        return {}
    cells: Dict[float, Tuple[float, float]] = {}
    for index, value in enumerate(values):
        if index == 0:
            left = 0.0 if total_duration is not None and total_duration > 0 else value - ((values[1] - value) / 2 if len(values) > 1 else 0.0)
        else:
            left = (values[index - 1] + value) / 2
        if index == len(values) - 1:
            right = float(total_duration) if total_duration is not None and total_duration > 0 else value + ((value - values[index - 1]) / 2 if len(values) > 1 else 0.0)
        else:
            right = (value + values[index + 1]) / 2
        if total_duration is not None and total_duration > 0:
            left = max(0.0, min(float(total_duration), left))
            right = max(0.0, min(float(total_duration), right))
        cells[value] = (left, max(left, right))
    return cells


def _covered_duration(
    timestamps: Sequence[float],
    timeline: Dict[float, Tuple[float, float]],
    start: float,
    end: float,
) -> float:
    intervals = []
    for timestamp in set(float(value) for value in timestamps if math.isfinite(float(value))):
        cell = timeline.get(timestamp)
        if cell is None:
            continue
        left = max(start, cell[0])
        right = min(end, cell[1])
        if right > left:
            intervals.append((left, right))
    intervals.sort()
    covered = 0.0
    current_start = current_end = None
    for left, right in intervals:
        if current_start is None:
            current_start, current_end = left, right
        elif left <= current_end:
            current_end = max(current_end, right)
        else:
            covered += current_end - current_start
            current_start, current_end = left, right
    if current_start is not None:
        covered += current_end - current_start
    return covered


def _cluster_timeline_span(
    cluster: Sequence[Tuple[FrameMatch, float]],
    *,
    source_timestamps: Optional[Sequence[float]],
    total_source_duration: Optional[float],
) -> float:
    source_times = [match.source_timestamp for match, _ in cluster]
    if not source_times:
        return 0.0
    timeline = _timeline_cells(
        source_timestamps if source_timestamps is not None else source_times,
        total_source_duration,
    )
    cells = [timeline[value] for value in set(source_times) if value in timeline]
    if not cells:
        return max(source_times) - min(source_times)
    return max(right for _, right in cells) - min(left for left, _ in cells)


def _deduplicate_bidirectional_segments(
    segments: List[MatchedSegment],
) -> List[MatchedSegment]:
    """
    Remove duplicate segments created by bidirectional matching.

    If segment A has source=(x1,y1), target=(x2,y2) and segment B has
    source=(x2,y2), target=(x1,y1), they are considered duplicates.
    Keep only the one with higher confidence (or first if equal).

    Args:
        segments: List of segments to deduplicate

    Returns:
        Deduplicated list of segments
    """
    if len(segments) <= 1:
        return segments

    # Create a key for each segment (normalized to handle bidirectional)
    def segment_key(seg: MatchedSegment) -> tuple:
        # Normalize by sorting the two time ranges
        range1 = (seg.source_start, seg.source_end)
        range2 = (seg.target_start, seg.target_end)
        return (min(range1, range2), max(range1, range2))

    seen = {}
    deduplicated = []

    for seg in segments:
        key = segment_key(seg)
        if key not in seen:
            seen[key] = seg
            deduplicated.append(seg)
        else:
            # Keep the one with higher confidence
            existing = seen[key]
            if seg.confidence > existing.confidence:
                # Replace existing with higher confidence segment
                deduplicated.remove(existing)
                deduplicated.append(seg)
                seen[key] = seg
            # If equal confidence, keep the first one (existing)

    return deduplicated


def _interval_iou(left_start: float, left_end: float, right_start: float, right_end: float) -> float:
    intersection = max(0.0, min(left_end, right_end) - max(left_start, right_start))
    union = max(left_end, right_end) - min(left_start, right_start)
    return intersection / union if union > 0 else 1.0 if left_start == right_start else 0.0


def _segments_are_same_directional_range(left: MatchedSegment, right: MatchedSegment) -> bool:
    source_iou = _interval_iou(left.source_start, left.source_end, right.source_start, right.source_end)
    target_iou = _interval_iou(left.target_start, left.target_end, right.target_start, right.target_end)
    close = (
        abs(left.source_start - right.source_start) <= SEGMENT_FUSION_TOLERANCE_SEC
        and abs(left.source_end - right.source_end) <= SEGMENT_FUSION_TOLERANCE_SEC
        and abs(left.target_start - right.target_start) <= SEGMENT_FUSION_TOLERANCE_SEC
        and abs(left.target_end - right.target_end) <= SEGMENT_FUSION_TOLERANCE_SEC
    )
    return (source_iou >= SEGMENT_FUSION_IOU and target_iou >= SEGMENT_FUSION_IOU) or close


def _fuse_directional_segments(segments: List[MatchedSegment]) -> List[MatchedSegment]:
    """Fuse duplicate directional ranges without merging disjoint clips."""
    fused: List[MatchedSegment] = []
    for segment in sorted(segments, key=lambda item: item.confidence, reverse=True):
        existing = next((item for item in fused if _segments_are_same_directional_range(item, segment)), None)
        if existing is None:
            fused.append(segment)
            continue
        total_weight = max(1, existing.match_count + segment.match_count)
        existing.avg_similarity = (
            existing.avg_similarity * existing.match_count
            + segment.avg_similarity * segment.match_count
        ) / total_weight
        existing.source_start = min(existing.source_start, segment.source_start)
        existing.source_end = max(existing.source_end, segment.source_end)
        existing.target_start = min(existing.target_start, segment.target_start)
        existing.target_end = max(existing.target_end, segment.target_end)
        existing.coverage = max(existing.coverage, segment.coverage)
        existing.confidence = max(existing.confidence, segment.confidence)
        existing.match_count = max(existing.match_count, segment.match_count)
    fused.sort(key=lambda item: item.confidence, reverse=True)
    return fused


def _create_segment_from_cluster(
    cluster: List[Tuple[FrameMatch, float]],
    source_timestamps: Optional[Sequence[float]] = None,
    total_source_duration: Optional[float] = None,
) -> Optional[MatchedSegment]:
    """
    Create a MatchedSegment from a cluster of matches.

    Args:
        cluster: List of (FrameMatch, offset) tuples

    Returns:
        MatchedSegment or None if cluster is invalid
    """
    if not cluster:
        return None

    matches = [m for m, _ in cluster]
    offsets = [o for _, o in cluster]

    # Calculate segment boundaries
    source_times = [m.source_timestamp for m in matches]
    target_times = [m.target_timestamp for m in matches]

    source_start = min(source_times)
    source_end = max(source_times)
    target_start = min(target_times)
    target_end = max(target_times)

    # Calculate statistics
    avg_similarity = sum(m.similarity for m in matches) / len(matches)
    avg_offset = sum(offsets) / len(offsets)

    # Estimate coverage from actual source timestamp cells.  The old
    # ``len(matches) / duration`` estimate silently assumed 1 retained frame
    # per second and over/under-counted dynamic samples.
    timeline = _timeline_cells(
        source_timestamps if source_timestamps is not None else source_times,
        total_source_duration,
    )
    duration = source_end - source_start
    if duration > 0:
        covered_duration = _covered_duration(
            source_times, timeline, source_start, source_end
        )
        coverage = min(1.0, covered_duration / duration) if covered_duration > 0 else 0.0
    else:
        coverage = 1.0 if matches else 0.0

    # Confidence based on:
    # - Number of matches (more = higher confidence)
    # - Average similarity (higher = higher confidence)
    # - Offset consistency (lower std = higher confidence)
    import numpy as np

    offset_std = float(np.std(offsets)) if len(offsets) > 1 else 0.0
    offset_consistency = max(0.0, 1.0 - offset_std / 10.0)  # Normalize

    confidence = (
        0.4 * min(1.0, len(matches) / 10.0)  # Match count factor
        + 0.4 * avg_similarity  # Similarity factor
        + 0.2 * offset_consistency  # Offset consistency factor
    )

    return MatchedSegment(
        source_start=source_start,
        source_end=source_end,
        target_start=target_start,
        target_end=target_end,
        coverage=coverage,
        avg_similarity=avg_similarity,
        confidence=confidence,
        match_count=len(matches),
    )
