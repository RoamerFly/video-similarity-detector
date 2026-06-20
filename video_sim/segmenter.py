"""
Video segment analysis module for video similarity search.

Provides time window similarity analysis and segment aggregation
for frame-level match results.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from video_sim.matcher import FrameMatch


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
) -> List[WindowSimilarity]:
    """
    Calculate similarity statistics for fixed time windows.

    Groups match points by source_timestamp into fixed-size windows
    and computes statistics for each window.

    Args:
        match_points: List of FrameMatch objects
        window_size: Window size in seconds (default: 30)
        total_source_duration: Total duration of source video (for last window)

    Returns:
        List of WindowSimilarity objects for each window
    """
    if not match_points:
        return []

    # Sort by source timestamp
    sorted_matches = sorted(match_points, key=lambda m: m.source_timestamp)

    # Determine time range - always include at least one window
    min_time = sorted_matches[0].source_timestamp
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

    while window_start < max_time:
        window_end = window_start + window_size

        # Get matches in this window
        window_matches = [
            m
            for m in sorted_matches
            if window_start <= m.source_timestamp < window_end
        ]

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

        # Estimate total frames in window (assuming ~1 frame per second)
        estimated_frames = max(1, int(window_size))
        matched_ratio = matched_count / estimated_frames

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
) -> List[MatchedSegment]:
    """
    Aggregate match points into contiguous segments.

    Groups matches with similar time offsets (target - source)
    into segments. Matches are clustered by offset similarity.

    Args:
        match_points: List of FrameMatch objects
        min_segment_duration: Minimum duration for a valid segment (seconds)
        min_segment_matches: Minimum number of matches for a valid segment
        offset_tolerance_sec: Maximum offset difference to consider matches as same segment

    Returns:
        List of MatchedSegment objects (deduplicated)
    """
    if not match_points:
        return []

    # Calculate offsets for each match
    matches_with_offset = []
    for m in match_points:
        offset = m.target_timestamp - m.source_timestamp
        matches_with_offset.append((m, offset))

    # Sort by offset for clustering
    matches_with_offset.sort(key=lambda x: x[1])

    # Cluster matches by offset similarity
    segments = []
    current_cluster = [matches_with_offset[0]]
    current_offset = matches_with_offset[0][1]

    for match, offset in matches_with_offset[1:]:
        # Check if this match belongs to current cluster based on offset similarity
        if abs(offset - current_offset) <= offset_tolerance_sec:
            # Add to current cluster
            current_cluster.append((match, offset))
            # Update running average offset
            current_offset = sum(o for _, o in current_cluster) / len(current_cluster)
        else:
            # Finalize current cluster and start new one
            if len(current_cluster) >= min_segment_matches:
                segment = _create_segment_from_cluster(current_cluster)
                if segment and segment.duration >= min_segment_duration:
                    segments.append(segment)

            current_cluster = [(match, offset)]
            current_offset = offset

    # Don't forget the last cluster
    if len(current_cluster) >= min_segment_matches:
        segment = _create_segment_from_cluster(current_cluster)
        if segment and segment.duration >= min_segment_duration:
            segments.append(segment)

    # Deduplicate bidirectional segments (A→B and B→A)
    segments = _deduplicate_bidirectional_segments(segments)

    # Sort by confidence (descending)
    segments.sort(key=lambda s: s.confidence, reverse=True)

    return segments


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


def _create_segment_from_cluster(
    cluster: List[Tuple[FrameMatch, float]]
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

    # Estimate coverage (what fraction of source segment is matched)
    duration = source_end - source_start
    if duration > 0:
        # Assume roughly 1 frame per second, coverage is matched frames / expected frames
        expected_frames = max(1, duration)
        coverage = min(1.0, len(matches) / expected_frames)
    else:
        coverage = 1.0 if len(matches) > 0 else 0.0

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
