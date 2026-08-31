"""Bounded temporal alignment for frame-level video matches.

The matcher can return several visual candidates for one source frame.  A
single greedy offset chain lets a distant candidate break a valid chain; this
module keeps a small, bounded set of affine temporal tracks instead.  The
implementation sorts candidates once, then makes one bounded-state pass over
them without constructing a source-by-target similarity matrix.  The active
track state is O(T), while the verified output and evidence are O(M).
"""

from dataclasses import dataclass, field
import math
from statistics import median
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple


DEFAULT_OFFSET_TOLERANCE_SEC = 3.0
DEFAULT_MAX_TRACKS = 64
DEFAULT_MIN_MATCHES = 3
DEFAULT_GAP_SEC = 10.0
GAP_MULTIPLIER = 3.0
TARGET_JITTER_SEC = 1.0
MIN_SLOPE = 0.65
MAX_SLOPE = 1.5
RESIDUAL_TOLERANCE_SEC = 2.0
STATIC_SOURCE_SPAN_SEC = 2.0
WEAK_TARGET_SPAN_RATIO = 0.25
STATIC_SIMILARITY_FLOOR = 0.80


@dataclass
class TemporalAlignment:
    """Validated tracks and evidence for one matching direction.

    ``tracks`` contains only accepted tracks.  ``verified_matches`` is their
    deterministic flattened view for report compatibility and windowing.
    ``alignment_computed`` is always true for values returned by
    :func:`align_matches`; callers can distinguish an old, unverified empty
    list by inspecting that flag on their result object.
    """

    tracks: List[List[Any]] = field(default_factory=list)
    verified_matches: List[Any] = field(default_factory=list)
    source_coverage: float = 0.0
    target_coverage: float = 0.0
    alignment_computed: bool = True
    evidence: Dict[str, Any] = field(default_factory=dict)

    @property
    def clusters(self) -> List[List[Any]]:
        """Alias used by segment aggregation code."""

        return self.tracks


class _OnlineAffineTrend:
    """Constant-memory running affine fit for one track."""

    __slots__ = ("count", "sum_x", "sum_y", "sum_xx", "sum_xy")

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


class _Track:
    __slots__ = (
        "matches",
        "source_keys",
        "source_time_keys",
        "target_keys",
        "last_source",
        "last_target",
        "offset_sum",
        "trend",
        "first_source",
        "first_target",
        "score",
    )

    def __init__(self, match: Any) -> None:
        self.matches: List[Any] = [match]
        self.source_keys: Set[Tuple[Any, ...]] = {_frame_key(match, "source")}
        self.source_time_keys: Set[float] = {_time_key(match, "source")}
        self.target_keys: Set[Tuple[Any, ...]] = {_frame_key(match, "target")}
        self.last_source = _timestamp(match, "source")
        self.last_target = _timestamp(match, "target")
        self.offset_sum = self.last_target - self.last_source
        self.trend = _OnlineAffineTrend()
        self.trend.add(self.last_source, self.last_target)
        self.first_source = self.last_source
        self.first_target = self.last_target
        self.score = _similarity(match)

    @property
    def count(self) -> int:
        return len(self.matches)

    @property
    def mean_offset(self) -> float:
        return self.offset_sum / max(1, self.count)

    def compatibility(
        self,
        match: Any,
        *,
        source_gap: float,
        target_gap: float,
        offset_tolerance_sec: float,
    ) -> Optional[float]:
        source = _timestamp(match, "source")
        target = _timestamp(match, "target")
        source_delta = source - self.last_source
        target_delta = target - self.last_target

        # One track contributes at most one candidate per source frame.  This
        # prevents top-k alternatives for one source sample from inflating its
        # evidence while still allowing those alternatives to form other tracks.
        if _frame_key(match, "source") in self.source_keys or abs(source_delta) <= 1e-9:
            return None
        if source_delta < -1e-9 or source_delta > source_gap:
            return None
        if target_delta < -TARGET_JITTER_SEC or target_delta > target_gap:
            return None

        offset = target - source
        offset_delta = abs(offset - self.mean_offset)
        residual = abs(self.trend.residual(source, target))
        slope = self.trend.parameters()[0]
        # A genuinely static shot can keep returning the same target sample
        # while source time advances.  Keep that candidate in its own track;
        # _track_is_valid applies the stricter global-neighborhood check after
        # all alternatives have been seen.  Without this exception the
        # repeated-target track is fragmented before it can be validated.
        exact_target_repeat = abs(target_delta) <= 1e-9 and source_delta > 1e-9
        # Offset is the robust short-track rule.  Once enough points exist,
        # an affine residual allows a long, mild speed change without forcing
        # the track to fragment as its offset drifts.
        affine_ok = (
            self.count >= 2
            and MIN_SLOPE <= slope <= MAX_SLOPE
            and residual <= RESIDUAL_TOLERANCE_SEC
        )
        if (
            self.count >= 2
            and offset_delta > offset_tolerance_sec
            and not affine_ok
            and not exact_target_repeat
        ):
            return None
        if target_delta <= TARGET_JITTER_SEC and source_delta > 1e-6:
            # Repeated target samples are allowed for genuinely static shots,
            # but a large source jump with no target advance is usually a
            # shuffled or concentrated false match.
            if target_delta > 1e-9 and source_delta > max(1.5, target_delta * 1.5):
                return None

        # Lower is better. Similarity only breaks otherwise equivalent ties;
        # it never makes an incompatible track valid.
        return min(offset_delta, residual if affine_ok else offset_delta) - 0.01 * _similarity(match)

    def append(self, match: Any) -> None:
        source = _timestamp(match, "source")
        target = _timestamp(match, "target")
        self.matches.append(match)
        self.source_keys.add(_frame_key(match, "source"))
        self.source_time_keys.add(_time_key(match, "source"))
        self.target_keys.add(_frame_key(match, "target"))
        self.last_source = source
        self.last_target = target
        self.offset_sum += target - source
        self.trend.add(source, target)
        self.score += _similarity(match)


def align_matches(
    matches: Sequence[Any],
    *,
    total_source_frames: int = 0,
    source_timestamps: Optional[Sequence[float]] = None,
    total_source_duration: Optional[float] = None,
    target_timestamps: Optional[Sequence[float]] = None,
    total_target_duration: Optional[float] = None,
    offset_tolerance_sec: float = DEFAULT_OFFSET_TOLERANCE_SEC,
    min_matches: int = DEFAULT_MIN_MATCHES,
    max_tracks: int = DEFAULT_MAX_TRACKS,
) -> TemporalAlignment:
    """Align candidates into a bounded set of temporally consistent tracks.

    The output memory is necessarily O(M) because callers need the verified
    matches for reports.  Active track state is O(T), where ``T`` is the fixed
    ``max_tracks`` cap; processing work is O(M log M + M*T).
    """

    if not matches:
        return TemporalAlignment(
            alignment_computed=True,
            evidence={
                "input_matches": 0,
                "deduplicated_matches": 0,
                "track_count": 0,
                "rejected_weak_tracks": 0,
                "max_tracks": max(1, int(max_tracks)),
                "tracks_truncated": False,
            },
        )

    max_tracks = max(1, int(max_tracks))
    min_matches = max(1, int(min_matches))
    offset_tolerance_sec = max(0.0, float(offset_tolerance_sec))
    source_gap = _gap_limit(source_timestamps, matches, "source")
    target_gap = _gap_limit(target_timestamps, matches, "target")

    unique: Dict[Tuple[Any, ...], Any] = {}
    for match in matches:
        if not _finite_match(match):
            continue
        key = (
            _frame_key(match, "source"),
            _frame_key(match, "target"),
            round(_timestamp(match, "source"), 9),
            round(_timestamp(match, "target"), 9),
        )
        previous = unique.get(key)
        if previous is None or _similarity(match) > _similarity(previous):
            unique[key] = match

    ordered = sorted(
        unique.values(),
        key=lambda item: (
            _timestamp(item, "source"),
            _timestamp(item, "target"),
            -_similarity(item),
            _frame_key(item, "source"),
            _frame_key(item, "target"),
        ),
    )
    all_target_timestamps = [
        _timestamp(item, "target") for item in ordered
    ]

    active: List[_Track] = []
    tracks_truncated = False
    for match in ordered:
        options: List[Tuple[float, int]] = []
        for index, track in enumerate(active):
            score = track.compatibility(
                match,
                source_gap=source_gap,
                target_gap=target_gap,
                offset_tolerance_sec=offset_tolerance_sec,
            )
            if score is not None:
                options.append((score, index))
        if options:
            _, best_index = min(options, key=lambda item: (item[0], item[1]))
            active[best_index].append(match)
        elif len(active) < max_tracks:
            active.append(_Track(match))
        else:
            # Do not force a candidate into the wrong track when the bounded
            # branch budget is exhausted; doing so damages both direction and
            # coverage. The evidence makes this cap observable to callers.
            tracks_truncated = True

    accepted: List[List[Any]] = []
    rejected_weak_tracks = 0
    for track in active:
        if _track_is_valid(
            track,
            min_matches=min_matches,
            total_source_frames=total_source_frames,
            source_timestamps=source_timestamps,
            target_timestamps=target_timestamps,
            all_target_timestamps=all_target_timestamps,
            total_source_duration=total_source_duration,
            total_target_duration=total_target_duration,
        ):
            accepted.append(sorted(track.matches, key=_match_sort_key))
        else:
            rejected_weak_tracks += 1

    accepted.sort(key=lambda cluster: _match_sort_key(cluster[0]))
    verified = [match for cluster in accepted for match in cluster]
    source_coverage = _coverage(
        [
            _timestamp(match, "source")
            for match in verified
        ],
        source_timestamps,
        total_source_duration,
        total_frames=total_source_frames,
    )
    target_coverage = _coverage(
        [
            _timestamp(match, "target")
            for match in verified
        ],
        target_timestamps,
        total_target_duration,
    )
    # A caller may provide no frame count, in which case the timestamp based
    # ratio still remains useful. With no duration/timeline, _coverage falls
    # back to an independent timestamp count rather than candidate count.
    evidence = {
        "input_matches": len(matches),
        "deduplicated_matches": len(ordered),
        "track_count": len(accepted),
        "rejected_weak_tracks": rejected_weak_tracks,
        "max_tracks": max_tracks,
        "tracks_truncated": tracks_truncated,
        "verified_match_count": len(verified),
        "verified_source_frame_count": len(_unique_frame_keys(verified, "source")),
        "verified_target_frame_count": len(_unique_frame_keys(verified, "target")),
        "verified_source_time_group_count": len(_unique_time_keys(verified, "source")),
        "verified_target_time_group_count": len(_unique_time_keys(verified, "target")),
        "static_neighborhood_span_sec": _target_neighborhood_span(all_target_timestamps),
    }
    return TemporalAlignment(
        tracks=accepted,
        verified_matches=verified,
        source_coverage=source_coverage,
        target_coverage=target_coverage,
        alignment_computed=True,
        evidence=evidence,
    )


def coverage_for_matches(
    matches: Sequence[Any],
    *,
    total_frames: int = 0,
    timestamps: Optional[Sequence[float]] = None,
    total_duration: Optional[float] = None,
    target_timestamps: Optional[Sequence[float]] = None,
    total_target_duration: Optional[float] = None,
    offset_tolerance_sec: float = DEFAULT_OFFSET_TOLERANCE_SEC,
    min_matches: int = DEFAULT_MIN_MATCHES,
    max_tracks: int = DEFAULT_MAX_TRACKS,
) -> float:
    """Return source coverage after the same alignment/evidence checks."""

    alignment = align_matches(
        matches,
        total_source_frames=total_frames,
        source_timestamps=timestamps,
        total_source_duration=total_duration,
        target_timestamps=target_timestamps,
        total_target_duration=total_target_duration,
        offset_tolerance_sec=offset_tolerance_sec,
        min_matches=min_matches,
        max_tracks=max_tracks,
    )
    return alignment.source_coverage


def _track_is_valid(
    track: _Track,
    *,
    min_matches: int,
    total_source_frames: int,
    source_timestamps: Optional[Sequence[float]],
    target_timestamps: Optional[Sequence[float]],
    all_target_timestamps: Optional[Sequence[float]],
    total_source_duration: Optional[float],
    total_target_duration: Optional[float],
) -> bool:
    # Timestamp is the evidence group.  A malformed cache can expose two
    # source ids for one retained timestamp; counting both would inflate the
    # denominator and let duplicate evidence pass validation.
    source_unique = len(track.source_time_keys)
    target_unique = len(track.target_keys)
    if len(track.matches) < min_matches or source_unique < min_matches:
        return False

    source_values = [_timestamp(match, "source") for match in track.matches]
    target_values = [_timestamp(match, "target") for match in track.matches]
    source_span = max(source_values) - min(source_values)
    target_span = max(target_values) - min(target_values)
    if len(track.matches) > 3 and max(source_span, target_span) < 1.0:
        return False

    # A track whose target advances materially must follow a plausible time
    # scale.  Early candidates have too little evidence for this check during
    # greedy assignment, so apply it once to the completed track as well.  It
    # rejects shuffled interleavings that happen to keep a loose offset while
    # preserving static target repetitions (target_span == 0).
    if source_span > 0.0 and target_span > TARGET_JITTER_SEC:
        slope = track.trend.parameters()[0]
        if not MIN_SLOPE <= slope <= MAX_SLOPE:
            return False
        if any(
            abs(track.trend.residual(source, target)) > RESIDUAL_TOLERANCE_SEC
            for source, target in zip(source_values, target_values)
        ):
            return False

    # A long source cannot be proven by repeatedly matching one or a handful
    # of isolated target frames. The exception for a genuinely short static
    # source preserves the useful old behavior for a static shot while keeping
    # concentrated matches in long videos weak.
    static_short_exception = source_span <= STATIC_SOURCE_SPAN_SEC and (
        total_source_duration is None
        or total_source_duration <= STATIC_SOURCE_SPAN_SEC * 2
        or total_source_frames <= 3
    )
    target_values_all = list(all_target_timestamps or target_values)
    static_neighborhood_limit = _target_neighborhood_span(target_values_all)
    all_target_span = (
        max(target_values_all) - min(target_values_all)
        if target_values_all
        else target_span
    )
    mean_similarity = sum(_similarity(match) for match in track.matches) / max(
        1, len(track.matches)
    )
    # Permit a long static source to reuse one target frame, or a very small
    # target neighborhood (for example several nearby retained frames).  The
    # complete candidate set must itself stay inside that neighborhood.  This
    # is what rejects the adversarial 0/1/2s target candidates: each individual
    # chain looks static, but the alternatives span multiple target cells.
    static_neighborhood_exception = (
        all_target_span <= static_neighborhood_limit
        and target_span <= static_neighborhood_limit
        and mean_similarity >= STATIC_SIMILARITY_FLOOR
    )
    if (
        not static_short_exception
        and not static_neighborhood_exception
        and source_unique > max(3, target_unique * 3)
        and target_span < max(1.0, source_span * WEAK_TARGET_SPAN_RATIO)
    ):
        return False
    if (
        target_unique <= 1
        and source_span > STATIC_SOURCE_SPAN_SEC
        and not static_short_exception
        and not static_neighborhood_exception
    ):
        return False

    # Both axes must carry some temporal extent when complete timelines are
    # available. For a repeated/static shot target span can be zero, handled by
    # the controlled short exception above.
    if source_timestamps is not None and target_timestamps is not None:
        if (
            source_span > 1.0
            and target_span <= 0.0
            and not static_short_exception
            and not static_neighborhood_exception
        ):
            return False
        if total_target_duration and total_source_duration and source_span > 0:
            expected = source_span * float(total_target_duration) / max(float(total_source_duration), 1e-9)
            if (
                expected > 1.0
                and target_span < expected * 0.05
                and not static_short_exception
                and not static_neighborhood_exception
            ):
                return False
    return True


def _coverage(
    timestamps: Sequence[float],
    timeline: Optional[Sequence[float]],
    total_duration: Optional[float],
    total_frames: int = 0,
) -> float:
    values = sorted({float(value) for value in timestamps if math.isfinite(float(value))})
    if not values:
        return 0.0
    duration = float(total_duration or 0.0)
    if duration > 0:
        # A duration alone is not a complete timeline.  Building midpoint
        # cells from the matched subset would make every non-empty subset look
        # like the whole video.  Use the independent frame evidence fallback
        # when the caller knows the source frame count.
        if timeline is None:
            return (
                min(1.0, len(values) / max(1, int(total_frames)))
                if total_frames > 0
                else 0.0
            )
        cells = _timeline_cells(timeline if timeline is not None else values, duration)
        covered = _covered_duration(values, cells, 0.0, duration)
        return min(1.0, covered / duration)
    if timeline is not None:
        complete = sorted({float(value) for value in timeline if math.isfinite(float(value))})
        return min(1.0, len(set(values)) / max(1, len(complete)))
    return min(1.0, len(values) / max(1, int(total_frames))) if total_frames > 0 else 1.0


def _timeline_cells(
    timestamps: Optional[Sequence[float]],
    total_duration: float,
) -> Dict[float, Tuple[float, float]]:
    raw = [] if timestamps is None else timestamps
    values = sorted({float(value) for value in raw if math.isfinite(float(value))})
    if not values or total_duration <= 0:
        return {}
    cells: Dict[float, Tuple[float, float]] = {}
    for index, value in enumerate(values):
        left = 0.0 if index == 0 else (values[index - 1] + value) / 2.0
        right = float(total_duration) if index == len(values) - 1 else (value + values[index + 1]) / 2.0
        cells[value] = (max(0.0, min(float(total_duration), left)), max(0.0, min(float(total_duration), right)))
    return cells


def _covered_duration(
    timestamps: Iterable[float],
    cells: Dict[float, Tuple[float, float]],
    start: float,
    end: float,
) -> float:
    intervals = []
    for value in set(float(timestamp) for timestamp in timestamps if math.isfinite(float(timestamp))):
        cell = cells.get(value)
        if cell is None:
            continue
        left, right = max(start, cell[0]), min(end, cell[1])
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


def _gap_limit(
    timeline: Optional[Sequence[float]],
    matches: Sequence[Any],
    axis: str,
) -> float:
    values = timeline if timeline is not None else [_timestamp(match, axis) for match in matches]
    finite = sorted(float(value) for value in values if math.isfinite(float(value)))
    gaps = [right - left for left, right in zip(finite, finite[1:]) if right > left]
    return max(DEFAULT_GAP_SEC, GAP_MULTIPLIER * (median(gaps) if gaps else 0.0))


def _timestamp(match: Any, axis: str) -> float:
    return float(getattr(match, f"{axis}_timestamp"))


def _frame_key(match: Any, axis: str) -> Tuple[Any, ...]:
    index = getattr(match, f"{axis}_frame_index", None)
    timestamp = _timestamp(match, axis)
    try:
        index_value = int(index)
    except (TypeError, ValueError):
        index_value = None
    # Timestamp is part of identity so malformed legacy records that reused an
    # index for different retained times do not collapse into one frame. Exact
    # duplicate records still collapse in align_matches.
    return (index_value, round(timestamp, 9))


def _time_key(match: Any, axis: str) -> float:
    """Return the evidence group for one retained timestamp."""

    return round(_timestamp(match, axis), 9)


def _unique_frame_keys(matches: Sequence[Any], axis: str) -> Set[Tuple[Any, ...]]:
    return {_frame_key(match, axis) for match in matches}


def _unique_time_keys(matches: Sequence[Any], axis: str) -> Set[float]:
    return {_time_key(match, axis) for match in matches}


def _target_neighborhood_span(timestamps: Sequence[float]) -> float:
    """Bound the target span treated as one static visual neighborhood."""

    values = sorted({float(value) for value in timestamps if math.isfinite(float(value))})
    if len(values) < 2:
        return 1.0
    gaps = [right - left for left, right in zip(values, values[1:]) if right > left]
    return max(1.0, 1.5 * (median(gaps) if gaps else 0.0))


def _similarity(match: Any) -> float:
    try:
        return float(getattr(match, "similarity", 0.0))
    except (TypeError, ValueError):
        return 0.0


def _finite_match(match: Any) -> bool:
    try:
        return math.isfinite(_timestamp(match, "source")) and math.isfinite(_timestamp(match, "target"))
    except (TypeError, ValueError, AttributeError):
        return False


def _match_sort_key(match: Any) -> Tuple[Any, ...]:
    return (
        _timestamp(match, "source"),
        _timestamp(match, "target"),
        -_similarity(match),
        _frame_key(match, "source"),
        _frame_key(match, "target"),
    )
