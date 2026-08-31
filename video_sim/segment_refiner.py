"""Low-cost local evidence for coarse video copy segments.

The regular recognizer deliberately stops at frame embeddings and temporal
alignment.  This module is an optional, decode-only second look at a small
number of coarse segments.  It does not change the matcher score, relation, or
the segments produced by :mod:`video_sim.segmenter`.

The module has no eager OpenCV or NumPy import.  That is intentional: batch
reports can import the configuration and keep the feature-cache stage light,
while the default ``off`` path does not touch a media file at all.

``reader_factory`` is injectable for tests and alternate decoders.  A reader
must expose ``read_at(seconds)`` and should expose ``close()`` (``release()``
is also accepted).  ``read_at`` may return a frame, ``(frame, timestamp)``, or
``(frame, timestamp, timestamp_basis)``.  The optional metadata attributes
``width``, ``height``, ``fps``, ``frame_count``, ``duration`` and
``timestamp_basis`` are used for safe clipping and provenance.
"""

from __future__ import annotations

import copy
import math
import numbers
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple


SEGMENT_REFINEMENT_VERSION = "segment-refiner-v2"
MIN_TRANSITION_COSINE = 0.80
MIN_CONSISTENT_TRANSITION_RATIO = 0.80
# Hard ceilings keep caller-provided refinement settings bounded even when a
# CLI/config file contains an accidental or maliciously large integer. The
# defaults remain intentionally much smaller for normal pair processing.
MAX_REFINEMENT_FRAMES = 4096
MAX_REFINEMENT_SEGMENTS = 64
MAX_REFINEMENT_INPUT_SEGMENTS = 4096
_EPSILON = 1e-8


@dataclass(frozen=True)
class RefinementConfig:
    """Configuration for local content-copy evidence.

    ``max_frames`` is a pair-wide budget: every source or target read attempt
    consumes one unit, including failed reads.  ``max_frame_pixels`` is a
    per-raw-frame safety limit; it protects the process from unexpectedly
    massive decoded frames without pretending to be an RSS limit.
    """

    mode: str = "off"
    sample_step_sec: float = 0.25
    padding_sec: float = 1.0
    search_radius_sec: float = 0.5
    max_segments: int = 4
    max_frames: int = 256
    max_wall_sec: float = 5.0
    max_frame_pixels: int = 8_294_400
    pixel_threshold: float = 0.92
    min_support: int = 3
    min_temporal_change: float = 0.02

    def __post_init__(self) -> None:
        if type(self.mode) is not str:
            raise TypeError("mode must be a string")
        if self.mode not in {"off", "copy", "copy-mirror"}:
            raise ValueError("mode must be 'off', 'copy', or 'copy-mirror'")

        for name in (
            "sample_step_sec",
            "padding_sec",
            "search_radius_sec",
            "max_wall_sec",
            "pixel_threshold",
            "min_temporal_change",
        ):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, numbers.Real):
                raise TypeError(f"{name} must be a finite number")
            if not math.isfinite(float(value)):
                raise ValueError(f"{name} must be finite")

        if self.sample_step_sec <= 0:
            raise ValueError("sample_step_sec must be greater than zero")
        if self.padding_sec < 0:
            raise ValueError("padding_sec must not be negative")
        if self.search_radius_sec < 0:
            raise ValueError("search_radius_sec must not be negative")
        if self.max_wall_sec <= 0:
            raise ValueError("max_wall_sec must be greater than zero")
        if not 0.0 <= self.pixel_threshold <= 1.0:
            raise ValueError("pixel_threshold must be between zero and one")
        if not 0.0 <= self.min_temporal_change <= 1.0:
            raise ValueError("min_temporal_change must be between zero and one")

        for name in ("max_segments", "max_frames", "max_frame_pixels", "min_support"):
            value = getattr(self, name)
            if type(value) is not int:
                raise TypeError(f"{name} must be an integer")
            if value <= 0:
                raise ValueError(f"{name} must be greater than zero")

        if self.max_frames > MAX_REFINEMENT_FRAMES:
            raise ValueError(
                f"max_frames must be <= {MAX_REFINEMENT_FRAMES}"
            )
        if self.max_segments > MAX_REFINEMENT_SEGMENTS:
            raise ValueError(
                f"max_segments must be <= {MAX_REFINEMENT_SEGMENTS}"
            )

        if self.min_support < 3:
            raise ValueError("min_support must be at least three")

    def to_dict(self) -> Dict[str, Any]:
        """Return the complete versioned, JSON-compatible configuration."""

        return {
            "version": SEGMENT_REFINEMENT_VERSION,
            "mode": self.mode,
            "sample_step_sec": float(self.sample_step_sec),
            "padding_sec": float(self.padding_sec),
            "search_radius_sec": float(self.search_radius_sec),
            "max_segments": self.max_segments,
            "max_frames": self.max_frames,
            "max_wall_sec": float(self.max_wall_sec),
            "max_frame_pixels": self.max_frame_pixels,
            "pixel_threshold": float(self.pixel_threshold),
            "min_support": self.min_support,
            "min_temporal_change": float(self.min_temporal_change),
            "min_transition_cosine": MIN_TRANSITION_COSINE,
        }


@dataclass
class _ReadOutcome:
    status: str
    descriptor: Any = None
    timestamp: Optional[float] = None
    timestamp_basis: str = "unknown"
    reason: str = ""
    raw_pixels: int = 0


@dataclass
class _SourceSample:
    requested_timestamp: float
    timestamp: float
    descriptor: Any
    timestamp_basis: str


@dataclass
class _Point:
    source_requested: float
    source_timestamp: float
    target_timestamp: float
    source_descriptor: Any
    target_descriptor: Any
    pixel_score: float
    structure_score: float
    score: float
    source_basis: str
    target_basis: str


@dataclass
class _BudgetState:
    attempts: int = 0
    frames_decoded: int = 0
    pixels_decoded: int = 0
    decode_errors: int = 0
    size_errors: int = 0
    stop_reason: str = ""


@dataclass
class _Interval:
    start: float
    end: float


class _OpenCVReader:
    """Small seek reader used only when callers do not inject a reader."""

    def __init__(self, video_path: str) -> None:
        import cv2

        self._cv2 = cv2
        self._capture = cv2.VideoCapture(video_path)
        if not self._capture.isOpened():
            self._capture.release()
            raise OSError(f"could not open video: {video_path}")

        self.width = _positive_int(self._capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = _positive_int(self._capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.fps = _positive_float(self._capture.get(cv2.CAP_PROP_FPS))
        self.frame_count = _positive_int(
            self._capture.get(cv2.CAP_PROP_FRAME_COUNT)
        )
        self.duration = (
            self.frame_count / self.fps
            if self.frame_count and self.fps
            else None
        )
        self.timestamp_basis = "opencv_pos_msec"

    def read_at(self, timestamp: float) -> Tuple[Any, Optional[float], str]:
        timestamp = max(0.0, float(timestamp))
        self._capture.set(self._cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
        ok, frame = self._capture.read()
        if not ok or frame is None:
            return None, None, self.timestamp_basis

        actual_msec = self._capture.get(self._cv2.CAP_PROP_POS_MSEC)
        if (
            isinstance(actual_msec, numbers.Real)
            and math.isfinite(float(actual_msec))
            and float(actual_msec) >= 0.0
            and (timestamp <= 1e-3 or float(actual_msec) > 1e-3)
        ):
            return frame, float(actual_msec) / 1000.0, self.timestamp_basis

        index = self._capture.get(self._cv2.CAP_PROP_POS_FRAMES) - 1.0
        if self.fps and math.isfinite(float(index)) and index >= 0:
            return frame, float(index) / self.fps, "frame_index_fps_estimate"
        return frame, timestamp, "requested_timestamp_approximate"

    def close(self) -> None:
        self._capture.release()


def _default_reader_factory(video_path: str) -> _OpenCVReader:
    return _OpenCVReader(video_path)


def _positive_int(value: Any) -> Optional[int]:
    try:
        parsed = int(round(float(value)))
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed > 0 else None


def _positive_float(value: Any) -> Optional[float]:
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed > 0 and math.isfinite(parsed) else None


def _clock_now(clock: Callable[[], float]) -> float:
    value = float(clock())
    if not math.isfinite(value):
        raise ValueError("clock must return a finite number")
    return value


def _elapsed(clock: Callable[[], float], start: float) -> float:
    return max(0.0, _clock_now(clock) - start)


def _check_cancel(cancel_check: Optional[Callable[[], None]]) -> None:
    if cancel_check is not None:
        cancel_check()


def _get_attr(reader: Any, names: Tuple[str, ...]) -> Any:
    metadata = getattr(reader, "metadata", None)
    if callable(metadata):
        try:
            metadata = metadata()
        except Exception:
            metadata = None
    if isinstance(metadata, Mapping):
        for name in names:
            if name in metadata:
                return metadata[name]

    for name in names:
        try:
            value = getattr(reader, name)
        except AttributeError:
            continue
        if callable(value) and name.startswith("get_"):
            try:
                value = value()
            except Exception:
                continue
        return value
    return None


def _reader_info(reader: Any) -> Dict[str, Any]:
    fps = _positive_float(_get_attr(reader, ("fps", "frame_rate", "get_fps")))
    frame_count = _positive_int(
        _get_attr(reader, ("frame_count", "num_frames", "total_frames", "get_frame_count"))
    )
    duration = _positive_float(
        _get_attr(reader, ("duration", "duration_sec", "get_duration"))
    )
    if duration is None and frame_count and fps:
        duration = frame_count / fps
    width = _positive_int(_get_attr(reader, ("width", "frame_width", "get_width")))
    height = _positive_int(_get_attr(reader, ("height", "frame_height", "get_height")))
    basis = _get_attr(reader, ("timestamp_basis",)) or "unknown"
    return {
        "fps": fps,
        "frame_count": frame_count,
        "duration": duration,
        "width": width,
        "height": height,
        "timestamp_basis": str(basis),
    }


def _known_pixels(info: Dict[str, Any]) -> Optional[int]:
    width = info.get("width")
    height = info.get("height")
    if not width or not height:
        return None
    return int(width) * int(height)


def _close_reader(reader: Any) -> None:
    if reader is None:
        return
    for name in ("close", "release"):
        method = getattr(reader, name, None)
        if callable(method):
            try:
                method()
            except Exception:
                # Some wrappers expose both methods but may fail during a
                # partial close. Continue to release() so a usable fallback
                # still gets a chance to free the native decoder.
                continue
            return


def _parse_read_result(result: Any, requested: float, basis: str) -> Tuple[Any, Optional[float], str]:
    if isinstance(result, Mapping):
        frame = result.get("frame")
        actual = result.get("timestamp", result.get("pts", requested))
        actual_basis = result.get("timestamp_basis", basis)
        return frame, _finite_timestamp(actual), str(actual_basis)

    if isinstance(result, (tuple, list)):
        if len(result) == 2 and isinstance(result[0], bool):
            return (result[1] if result[0] else None), requested, basis
        if len(result) >= 3:
            return result[0], _finite_timestamp(result[1]), str(result[2] or basis)
        if len(result) == 2:
            return result[0], _finite_timestamp(result[1]), basis
        if len(result) == 1:
            return result[0], requested, basis
    return result, requested, basis


def _finite_timestamp(value: Any) -> Optional[float]:
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if math.isfinite(parsed) and parsed >= 0.0 else None


def _invoke_reader(reader: Any, timestamp: float, basis: str) -> Tuple[Any, Optional[float], str]:
    for name in ("read_at", "read_frame_at", "get_frame_at", "read_frame", "read"):
        method = getattr(reader, name, None)
        if callable(method):
            return _parse_read_result(method(float(timestamp)), timestamp, basis)
    raise TypeError("reader must expose read_at(seconds)")


def _prepare_descriptor(frame: Any, preprocess_config: Any) -> Tuple[Any, int]:
    """Prepare one raw frame and return a compact RGB float descriptor."""

    import numpy as np
    import cv2

    array = np.asarray(frame)
    if array.ndim == 2:
        channels = cv2.cvtColor(array, cv2.COLOR_GRAY2BGR)
    elif array.ndim == 3 and array.shape[2] == 4:
        channels = cv2.cvtColor(array, cv2.COLOR_BGRA2BGR)
    elif array.ndim == 3 and array.shape[2] == 3:
        channels = array
    else:
        raise ValueError(f"unsupported frame shape: {array.shape}")

    if channels.dtype != np.uint8:
        channels = np.clip(channels, 0, 255).astype(np.uint8)
    raw_pixels = int(channels.shape[0]) * int(channels.shape[1])

    from video_sim.preprocess import PreprocessConfig, preprocess_frame_geometry

    if preprocess_config is None:
        preprocess_config = PreprocessConfig()
    elif isinstance(preprocess_config, Mapping):
        preprocess_config = PreprocessConfig.from_dict(dict(preprocess_config))
    prepared = preprocess_frame_geometry(
        channels,
        preprocess_config,
        target_size=32,
        interpolation=cv2.INTER_AREA,
    )
    if prepared.ndim == 2:
        prepared = cv2.cvtColor(prepared, cv2.COLOR_GRAY2BGR)
    rgb = prepared[:, :, ::-1]
    descriptor = np.asarray(rgb, dtype=np.float32).reshape(-1) / 255.0
    return descriptor, raw_pixels


def _score_descriptors(left: Any, right: Any) -> Tuple[float, float, float]:
    import numpy as np

    delta = np.abs(left - right)
    pixel_score = float(1.0 - np.mean(delta))
    centered_left = left - np.mean(left)
    centered_right = right - np.mean(right)
    left_norm = float(np.linalg.norm(centered_left))
    right_norm = float(np.linalg.norm(centered_right))
    if left_norm <= _EPSILON or right_norm <= _EPSILON:
        structure_score = 0.0
    else:
        cosine = float(np.dot(centered_left, centered_right) / (left_norm * right_norm))
        structure_score = (max(-1.0, min(1.0, cosine)) + 1.0) / 2.0
    pixel_score = max(0.0, min(1.0, pixel_score))
    structure_score = max(0.0, min(1.0, structure_score))
    return pixel_score, structure_score, min(pixel_score, structure_score)


def _mirror_descriptor(descriptor: Any) -> Any:
    """Mirror the spatial 32x32 RGB descriptor, preserving time order."""

    import numpy as np

    if getattr(descriptor, "size", 0) != 32 * 32 * 3:
        raise ValueError("unexpected refinement descriptor shape")
    return np.flip(np.asarray(descriptor).reshape(32, 32, 3), axis=1).reshape(-1).copy()


def _transition_cosine(left_delta: Any, right_delta: Any) -> Optional[float]:
    import numpy as np

    left_norm = float(np.linalg.norm(left_delta))
    right_norm = float(np.linalg.norm(right_delta))
    if left_norm <= _EPSILON or right_norm <= _EPSILON:
        return None
    cosine = float(np.dot(left_delta, right_delta) / (left_norm * right_norm))
    if not math.isfinite(cosine):
        return None
    return max(-1.0, min(1.0, cosine))


def _basis_value(values: Sequence[str], fallback: str = "unknown") -> str:
    unique = sorted({str(value) for value in values if value})
    if not unique:
        return fallback
    return unique[0] if len(unique) == 1 else "mixed"


def _segment_coarse(segment: Any) -> Dict[str, Any]:
    if isinstance(segment, Mapping):
        return copy.deepcopy(dict(segment))
    to_dict = getattr(segment, "to_dict", None)
    if callable(to_dict):
        try:
            value = to_dict()
            if isinstance(value, Mapping):
                return copy.deepcopy(dict(value))
        except Exception:
            pass
    fields = {}
    for name in (
        "source_start",
        "source_end",
        "target_start",
        "target_end",
        "coverage",
        "avg_similarity",
        "confidence",
        "match_count",
    ):
        if hasattr(segment, name):
            fields[name] = copy.deepcopy(getattr(segment, name))
    return fields


def _safe_value(value: Any) -> Any:
    """Make invalid-input coarse evidence safe for JSON serialization."""

    if isinstance(value, Mapping):
        return {str(key): _safe_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe_value(item) for item in value]
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, numbers.Real) and not isinstance(value, bool):
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    if isinstance(value, (str, bool)) or value is None:
        return value
    try:
        copy.deepcopy(value)
    except Exception:
        return repr(value)
    return value


def _segment_bounds(segment: Any) -> Optional[Tuple[float, float, float, float]]:
    values = []
    for name in ("source_start", "source_end", "target_start", "target_end"):
        value = segment.get(name) if isinstance(segment, Mapping) else getattr(segment, name, None)
        if isinstance(value, bool) or not isinstance(value, numbers.Real):
            return None
        parsed = float(value)
        if not math.isfinite(parsed):
            return None
        values.append(parsed)
    return tuple(values)  # type: ignore[return-value]


def _coerce_segments(segments: Any) -> List[Any]:
    """Validate and copy the finite segment sequence accepted by the API."""

    if segments is None:
        return []
    if isinstance(segments, (str, bytes, bytearray)) or not isinstance(
        segments, Sequence
    ):
        raise TypeError(
            "segments must be a finite Sequence (list/tuple); generators and text are not supported"
        )
    try:
        segment_count = len(segments)
    except TypeError as exc:
        raise TypeError("segments must provide a finite length") from exc
    if segment_count > MAX_REFINEMENT_INPUT_SEGMENTS:
        raise ValueError(
            f"segments length must be <= {MAX_REFINEMENT_INPUT_SEGMENTS}"
        )
    return list(segments)


def _clip_interval(start: float, end: float, duration: Optional[float]) -> Optional[_Interval]:
    if duration is not None and duration > 0.0:
        start = min(start, duration)
        end = min(end, duration)
    start = max(0.0, start)
    end = max(0.0, end)
    if end <= start:
        return None
    return _Interval(start, end)


def _window(interval: _Interval, padding: float, duration: Optional[float]) -> _Interval:
    start = max(0.0, interval.start - padding)
    end = interval.end + padding
    if duration is not None and duration > 0:
        end = min(duration, end)
    return _Interval(start, max(start, end))


def _sample_times(interval: _Interval, step: float) -> List[float]:
    if interval.end <= interval.start:
        return []
    values: List[float] = []
    count = max(1, int(math.ceil((interval.end - interval.start) / step)))
    for index in range(count + 1):
        value = min(interval.end, interval.start + index * step)
        if not values or abs(value - values[-1]) > 1e-9:
            values.append(value)
        if value >= interval.end:
            break
    return values


def _candidate_times(
    center: float,
    interval: _Interval,
    radius: float,
    step: float,
    max_candidates: int,
) -> List[float]:
    """Return center-first local candidates at the configured time grid."""

    center = min(interval.end, max(interval.start, center))
    values = [center]
    dedup_epsilon = 1e-9
    center_bucket = int(math.floor(center / dedup_epsilon))
    seen_buckets = {center_bucket}
    seen_values = {center_bucket: center}
    if radius <= 0:
        return values
    try:
        quotient = radius / max(step, _EPSILON)
    except (OverflowError, ZeroDivisionError):
        quotient = float("inf")
    if not math.isfinite(quotient):
        offset_count = max(1, (max_candidates - 1) // 2)
    else:
        offset_count = min(
            max(1, int(math.ceil(quotient))),
            max(1, (max_candidates - 1) // 2),
        )
    offsets: List[float] = []
    for index in range(1, offset_count + 1):
        offset = min(radius, index * step)
        offsets.extend((-offset, offset))
    for offset in offsets:
        candidate = min(interval.end, max(interval.start, center + offset))
        bucket = int(math.floor(candidate / dedup_epsilon))
        duplicate = False
        # Neighboring epsilon buckets can still contain values within the
        # historical tolerance. Three constant-time lookups preserve that
        # boundary behavior without rescanning every earlier candidate.
        for neighbor in (bucket - 1, bucket, bucket + 1):
            if neighbor not in seen_buckets:
                continue
            existing = seen_values.get(neighbor)
            if existing is not None and abs(candidate - existing) <= dedup_epsilon:
                duplicate = True
                break
        if not duplicate:
            seen_buckets.add(bucket)
            seen_values[bucket] = candidate
            values.append(candidate)
    return values


def _mapping_time(
    source_time: float,
    source: _Interval,
    target: _Interval,
    ratio: float,
) -> float:
    progress = (source_time - source.start) / max(_EPSILON, source.end - source.start)
    # Padding deliberately asks for points outside the coarse interval. Keep
    # the affine extrapolation here and clip only when candidates are bounded
    # by the target local window.
    return target.start + progress * (target.end - target.start)


def _support_runs(
    points: Sequence[_Point],
    step: float,
    threshold: float,
    ratio: float,
) -> List[List[_Point]]:
    supports = sorted(
        (point for point in points if point.score >= threshold),
        key=lambda point: point.source_timestamp,
    )
    if not supports:
        return []
    max_source_gap = max(step * 2.1, step + 1e-3)
    max_target_gap = max(step * 2.1 * ratio, step * ratio + 1e-3)
    runs: List[List[_Point]] = [[supports[0]]]
    for point in supports[1:]:
        previous = runs[-1][-1]
        source_gap = point.source_timestamp - previous.source_timestamp
        target_gap = point.target_timestamp - previous.target_timestamp
        if source_gap <= max_source_gap and target_gap <= max_target_gap:
            runs[-1].append(point)
        else:
            runs.append([point])
    return runs


def _overlap(left_start: float, left_end: float, right_start: float, right_end: float) -> float:
    return max(0.0, min(left_end, right_end) - max(left_start, right_start))


def _proposal_for_run(
    run: Sequence[_Point],
    all_points: Sequence[_Point],
    source_window: _Interval,
    target_window: _Interval,
    source_coarse: _Interval,
    target_coarse: _Interval,
    ratio: float,
) -> Optional[Dict[str, float]]:
    if not run:
        return None
    ordered = sorted(all_points, key=lambda point: point.source_timestamp)
    first = min(run, key=lambda point: point.source_timestamp)
    last = max(run, key=lambda point: point.source_timestamp)
    first_index = next(index for index, point in enumerate(ordered) if point is first)
    last_index = next(index for index, point in enumerate(ordered) if point is last)
    previous_time = (
        ordered[first_index - 1].source_timestamp
        if first_index > 0
        else source_window.start
    )
    next_time = (
        ordered[last_index + 1].source_timestamp
        if last_index + 1 < len(ordered)
        else source_window.end
    )
    source_start = min(source_window.end, max(source_window.start, (previous_time + first.source_timestamp) / 2.0))
    source_end = min(source_window.end, max(source_start, (last.source_timestamp + next_time) / 2.0))
    previous_target_candidates = [
        point.target_timestamp
        for point in ordered[:first_index]
        if point.target_timestamp < first.target_timestamp - 1e-9
    ]
    next_target_candidates = [
        point.target_timestamp
        for point in ordered[last_index + 1 :]
        if point.target_timestamp > last.target_timestamp + 1e-9
    ]
    previous_target = (
        max(previous_target_candidates)
        if previous_target_candidates
        else target_window.start
    )
    next_target = (
        min(next_target_candidates)
        if next_target_candidates
        else target_window.end
    )
    # Use actual matched timestamps and neighboring sampled cells for the
    # target boundary. Recomputing the coarse affine map here would erase the
    # seek backend's observed PTS precision.
    target_start = (previous_target + first.target_timestamp) / 2.0
    target_end = (last.target_timestamp + next_target) / 2.0
    target_start, target_end = min(target_start, target_end), max(target_start, target_end)
    target_start = min(target_window.end, max(target_window.start, target_start))
    target_end = min(target_window.end, max(target_start, target_end))
    if source_end <= source_start or target_end <= target_start:
        return None
    if _overlap(source_start, source_end, source_coarse.start, source_coarse.end) <= 0:
        return None
    if _overlap(target_start, target_end, target_coarse.start, target_coarse.end) <= 0:
        return None
    return {
        "source_start": float(source_start),
        "source_end": float(source_end),
        "target_start": float(target_start),
        "target_end": float(target_end),
    }


def _proposal_is_adoptable(
    run: Sequence[_Point],
    proposal: Mapping[str, float],
    source_coarse: _Interval,
    target_coarse: _Interval,
) -> bool:
    """Require evidence across the complete coarse interval before adoption."""

    if not run:
        return False
    ordered = sorted(run, key=lambda point: point.source_timestamp)
    source_covered = (
        ordered[0].source_timestamp <= source_coarse.start + 1e-6
        and ordered[-1].source_timestamp >= source_coarse.end - 1e-6
    )
    target_timestamps = [point.target_timestamp for point in ordered]
    target_covered = (
        min(target_timestamps) <= target_coarse.start + 1e-6
        and max(target_timestamps) >= target_coarse.end - 1e-6
    )
    # A boundary suggestion may expand the coarse interval, but never qualify
    # for automatic adoption while shrinking an unverified coarse edge.
    proposal_covers = (
        proposal["source_start"] <= source_coarse.start + 1e-6
        and proposal["source_end"] >= source_coarse.end - 1e-6
        and proposal["target_start"] <= target_coarse.start + 1e-6
        and proposal["target_end"] >= target_coarse.end - 1e-6
    )
    return bool(source_covered and target_covered and proposal_covers)


def _direction_evidence(
    points: Sequence[_Point],
    config: RefinementConfig,
    source_window: _Interval,
    target_window: _Interval,
    source_coarse: _Interval,
    target_coarse: _Interval,
    mirror: bool,
    ratio: float,
    decode_errors: int,
) -> Dict[str, Any]:
    ordered = sorted(points, key=lambda point: point.source_timestamp)
    runs = _support_runs(
        ordered,
        config.sample_step_sec,
        config.pixel_threshold,
        ratio,
    )
    run = max(
        runs,
        key=lambda values: (
            len(values),
            sum(point.score for point in values) / max(1, len(values)),
        ),
        default=[],
    )
    support = [point for point in ordered if point.score >= config.pixel_threshold]
    transitions = 0
    consistent_transitions = 0
    source_changes: List[float] = []
    target_changes: List[float] = []
    transition_cosines: List[float] = []
    max_gap = max(config.sample_step_sec * 2.1, config.sample_step_sec + 1e-3)
    for left, right in zip(run, run[1:]):
        if right.source_timestamp - left.source_timestamp > max_gap:
            continue
        import numpy as np

        source_delta = right.source_descriptor - left.source_descriptor
        target_delta = right.target_descriptor - left.target_descriptor
        source_change = float(np.mean(np.abs(source_delta)))
        target_change = float(np.mean(np.abs(target_delta)))
        if source_change < config.min_temporal_change or target_change < config.min_temporal_change:
            continue
        transitions += 1
        source_changes.append(source_change)
        target_changes.append(target_change)
        cosine = _transition_cosine(source_delta, target_delta)
        if cosine is None:
            continue
        transition_cosines.append(cosine)
        if cosine >= MIN_TRANSITION_COSINE:
            consistent_transitions += 1

    basis_source = _basis_value([point.source_basis for point in ordered])
    basis_target = _basis_value([point.target_basis for point in ordered])
    scores = [point.score for point in support]
    evidence: Dict[str, Any] = {
        "direction": "mirror" if mirror else "copy",
        "sample_count": len(ordered),
        "support_count": len(support),
        "support_run_count": len(run),
        "mean_score": float(sum(scores) / len(scores)) if scores else 0.0,
        "mean_pixel_score": float(sum(point.pixel_score for point in support) / len(support))
        if support
        else 0.0,
        "mean_structure_score": float(sum(point.structure_score for point in support) / len(support))
        if support
        else 0.0,
        "valid_transition_count": transitions,
        "consistent_transition_count": consistent_transitions,
        "transition_cosine_threshold": MIN_TRANSITION_COSINE,
        "consistent_transition_ratio_threshold": MIN_CONSISTENT_TRANSITION_RATIO,
        "mean_source_temporal_change": float(sum(source_changes) / len(source_changes))
        if source_changes
        else 0.0,
        "mean_target_temporal_change": float(sum(target_changes) / len(target_changes))
        if target_changes
        else 0.0,
        "mean_transition_cosine": float(sum(transition_cosines) / len(transition_cosines))
        if transition_cosines
        else 0.0,
        "timestamp_basis": {"source": basis_source, "target": basis_target},
        "decode_errors": int(decode_errors),
        "support_points": [
            {
                "source_timestamp": float(point.source_timestamp),
                "target_timestamp": float(point.target_timestamp),
                "pixel_score": float(point.pixel_score),
                "structure_score": float(point.structure_score),
                "score": float(point.score),
            }
            for point in support
        ],
    }

    if not support:
        evidence["reason"] = "decode_error" if decode_errors and not ordered else "no_visual_support"
        return {
            "status": "decode_error" if decode_errors and not ordered else "rejected",
            "reason": evidence["reason"],
            "evidence": evidence,
            "proposal": None,
        }
    if len(run) < config.min_support:
        evidence["reason"] = "insufficient_continuous_support"
        return {
            "status": "insufficient_evidence",
            "reason": evidence["reason"],
            "evidence": evidence,
            "proposal": None,
        }
    if transitions < 2:
        evidence["reason"] = "insufficient_temporal_change"
        return {
            "status": "insufficient_evidence",
            "reason": evidence["reason"],
            "evidence": evidence,
            "proposal": None,
        }
    if consistent_transitions < 2:
        evidence["reason"] = "temporal_change_direction_inconsistent"
        return {
            "status": "insufficient_evidence",
            "reason": evidence["reason"],
            "evidence": evidence,
            "proposal": None,
        }
    consistency_ratio = consistent_transitions / max(1, transitions)
    evidence["consistent_transition_ratio"] = float(consistency_ratio)
    if consistency_ratio < MIN_CONSISTENT_TRANSITION_RATIO:
        evidence["reason"] = "temporal_change_direction_inconsistent"
        return {
            "status": "insufficient_evidence",
            "reason": evidence["reason"],
            "evidence": evidence,
            "proposal": None,
        }

    proposal = _proposal_for_run(
        run,
        ordered,
        source_window,
        target_window,
        source_coarse,
        target_coarse,
        ratio,
    )
    if proposal is None:
        evidence["reason"] = "proposal_does_not_overlap_coarse_segment"
        return {
            "status": "insufficient_evidence",
            "reason": evidence["reason"],
            "evidence": evidence,
            "proposal": None,
        }
    proposal_adoptable = _proposal_is_adoptable(
        run,
        proposal,
        source_coarse,
        target_coarse,
    )
    evidence["proposal_adoptable"] = proposal_adoptable
    evidence["proposal_reason"] = (
        "full_coarse_coverage"
        if proposal_adoptable
        else "coarse_interval_not_fully_supported"
    )
    if not proposal_adoptable:
        local_source_start = min(point.source_timestamp for point in run)
        local_source_end = max(point.source_timestamp for point in run)
        local_target_start = min(point.target_timestamp for point in run)
        local_target_end = max(point.target_timestamp for point in run)
        evidence["local_verified_interval"] = {
            "source_start": float(local_source_start),
            "source_end": float(local_source_end),
            "target_start": float(local_target_start),
            "target_end": float(local_target_end),
        }
        evidence["reason"] = "local_support_does_not_cover_coarse"
        return {
            "status": "insufficient_evidence",
            "reason": evidence["reason"],
            "evidence": evidence,
            "proposal": None,
            "proposal_adoptable": False,
        }
    evidence["reason"] = (
        "local_copy_supported"
        if proposal_adoptable
        else "local_copy_supported_boundary_not_adoptable"
    )
    return {
        "status": "verified",
        "reason": evidence["reason"],
        "evidence": evidence,
        "proposal": proposal,
        "proposal_adoptable": proposal_adoptable,
    }


def _read_descriptor(
    reader: Any,
    info: Dict[str, Any],
    timestamp: float,
    config: RefinementConfig,
    preprocess_config: Any,
    state: _BudgetState,
    start: float,
    clock: Callable[[], float],
    cancel_check: Optional[Callable[[], None]],
) -> _ReadOutcome:
    if state.attempts >= config.max_frames:
        state.stop_reason = "max_frames"
        return _ReadOutcome("budget_exceeded", reason="max_frames")
    if _elapsed(clock, start) >= config.max_wall_sec:
        state.stop_reason = "max_wall_sec"
        return _ReadOutcome("budget_exceeded", reason="max_wall_sec")
    known_pixels = _known_pixels(info)
    if known_pixels is not None and known_pixels > config.max_frame_pixels:
        state.size_errors += 1
        state.stop_reason = "max_frame_pixels"
        return _ReadOutcome("budget_exceeded", reason="max_frame_pixels")

    _check_cancel(cancel_check)
    state.attempts += 1
    try:
        frame, actual_timestamp, actual_basis = _invoke_reader(
            reader,
            timestamp,
            info.get("timestamp_basis", "unknown"),
        )
    except Exception as exc:
        state.decode_errors += 1
        return _ReadOutcome("decode_error", reason=type(exc).__name__)
    _check_cancel(cancel_check)

    if frame is None:
        state.decode_errors += 1
        return _ReadOutcome("decode_error", reason="read_failed")
    try:
        import numpy as np

        shape = np.asarray(frame).shape
        if len(shape) < 2 or int(shape[0]) <= 0 or int(shape[1]) <= 0:
            raise ValueError(f"invalid frame shape: {shape}")
        raw_pixels = int(shape[0]) * int(shape[1])
    except Exception as exc:
        state.decode_errors += 1
        return _ReadOutcome("decode_error", reason=type(exc).__name__)
    if raw_pixels > config.max_frame_pixels:
        state.size_errors += 1
        state.stop_reason = "max_frame_pixels"
        return _ReadOutcome("budget_exceeded", reason="max_frame_pixels", raw_pixels=raw_pixels)

    state.frames_decoded += 1
    state.pixels_decoded += raw_pixels
    if _elapsed(clock, start) >= config.max_wall_sec:
        state.stop_reason = "max_wall_sec"
        return _ReadOutcome("budget_exceeded", reason="max_wall_sec", raw_pixels=raw_pixels)
    try:
        descriptor, _ = _prepare_descriptor(frame, preprocess_config)
    except Exception as exc:
        state.decode_errors += 1
        return _ReadOutcome("decode_error", reason=type(exc).__name__, raw_pixels=raw_pixels)
    actual_timestamp = _finite_timestamp(actual_timestamp)
    if actual_timestamp is None:
        actual_timestamp = float(timestamp)
        actual_basis = "requested_timestamp_approximate"
    return _ReadOutcome(
        "ok",
        descriptor=descriptor,
        timestamp=actual_timestamp,
        timestamp_basis=str(actual_basis or info.get("timestamp_basis", "unknown")),
        raw_pixels=raw_pixels,
    )


def _evaluate_direction(
    source_samples: Sequence[_SourceSample],
    target_reader: Any,
    target_info: Dict[str, Any],
    source_coarse: _Interval,
    target_coarse: _Interval,
    source_window: _Interval,
    target_window: _Interval,
    ratio: float,
    mirror: bool,
    config: RefinementConfig,
    preprocess_config: Any,
    state: _BudgetState,
    start: float,
    clock: Callable[[], float],
    cancel_check: Optional[Callable[[], None]],
) -> Tuple[List[_Point], int, bool]:
    points: List[_Point] = []
    decode_errors = 0
    stopped = False
    last_support_target_timestamp: Optional[float] = None
    for sample in source_samples:
        mapped = _mapping_time(
            sample.timestamp,
            source_coarse,
            target_coarse,
            ratio,
        )
        candidates = _candidate_times(
            mapped,
            target_window,
            config.search_radius_sec,
            config.sample_step_sec,
            max(1, config.max_frames - state.attempts),
        )
        comparison_source_descriptor = (
            _mirror_descriptor(sample.descriptor) if mirror else sample.descriptor
        )
        best: Optional[_Point] = None
        for candidate_index, candidate in enumerate(candidates):
            outcome = _read_descriptor(
                target_reader,
                target_info,
                candidate,
                config,
                preprocess_config,
                state,
                start,
                clock,
                cancel_check,
            )
            if outcome.status == "budget_exceeded":
                stopped = True
                break
            if outcome.status != "ok":
                decode_errors += 1
                continue
            if (
                last_support_target_timestamp is not None
                and float(outcome.timestamp) <= last_support_target_timestamp + 1e-9
            ):
                # A seek backend can return the same or an earlier frame for
                # nearby requests. It is not independent temporal evidence.
                continue
            if (
                float(outcome.timestamp) < target_window.start - 1e-6
                or float(outcome.timestamp) > target_window.end + 1e-6
            ):
                continue
            pixel_score, structure_score, score = _score_descriptors(
                comparison_source_descriptor,
                outcome.descriptor,
            )
            point = _Point(
                source_requested=sample.requested_timestamp,
                source_timestamp=sample.timestamp,
                target_timestamp=float(outcome.timestamp),
                source_descriptor=comparison_source_descriptor,
                target_descriptor=outcome.descriptor,
                pixel_score=pixel_score,
                structure_score=structure_score,
                score=score,
                source_basis=sample.timestamp_basis,
                target_basis=outcome.timestamp_basis,
            )
            if best is None or (point.score, point.structure_score) > (
                best.score,
                best.structure_score,
            ):
                best = point
            # A passing center is enough; searching the radius after a strong
            # match would spend the pair budget without changing evidence.
            if candidate_index == 0 and score >= config.pixel_threshold:
                break
        if best is not None:
            points.append(best)
            if best.score >= config.pixel_threshold:
                last_support_target_timestamp = best.target_timestamp
        if stopped:
            break
    return points, decode_errors, stopped


def _status_result(
    index: int,
    coarse: Dict[str, Any],
    status: str,
    reason: str,
    proposal: Optional[Dict[str, float]] = None,
    evidence: Optional[Dict[str, Any]] = None,
    proposal_adoptable: Optional[bool] = None,
) -> Dict[str, Any]:
    result = {
        "segment_index": int(index),
        "status": status,
        "reason": reason,
        "coarse": coarse,
        "proposal": proposal,
        "evidence": evidence or {},
    }
    if proposal_adoptable is not None:
        result["proposal_adoptable"] = bool(proposal_adoptable)
    return result


def refine_segments(
    video_a: str | Path,
    video_b: str | Path,
    segments: Sequence[Any],
    *,
    config: RefinementConfig,
    preprocess_config: Any = None,
    cancel_check: Optional[Callable[[], None]] = None,
    reader_factory: Optional[Callable[[str], Any]] = None,
    clock: Callable[[], float] = time.perf_counter,
) -> Optional[Dict[str, Any]]:
    """Validate coarse segments with bounded local pixel/structure evidence.

    The function returns ``None`` for ``mode='off'`` before converting the
    segment sequence, opening a reader, or importing a media dependency.  A
    malformed segment, bad video, decoder error, or exhausted budget becomes a
    per-segment status and preserves its coarse input in the returned object.
    Exceptions raised by ``cancel_check`` deliberately propagate after readers
    are closed so the batch cancellation path can pause the report.
    """

    if not isinstance(config, RefinementConfig):
        raise TypeError("config must be a RefinementConfig")
    if config.mode == "off":
        return None
    if not callable(clock):
        raise TypeError("clock must be callable")
    segment_values = _coerce_segments(segments)

    started = _clock_now(clock)
    cpu_started = time.process_time()
    state = _BudgetState()
    factory = reader_factory or _default_reader_factory
    readers: List[Any] = []
    infos: List[Dict[str, Any]] = []
    output_segments: List[Dict[str, Any]] = []

    try:
        if not segment_values:
            return {
                "version": SEGMENT_REFINEMENT_VERSION,
                "mode": config.mode,
                "config": config.to_dict(),
                "segments": [],
                "metrics": {
                    "frames_decoded": 0,
                    "frame_attempts": 0,
                    "pixels_decoded": 0,
                    "elapsed_ms": 0.0,
                    "cpu_ms": 0.0,
                    "segments_processed": 0,
                    "timestamp_basis": {"source": "unknown", "target": "unknown"},
                },
            }
        _check_cancel(cancel_check)
        open_error: Optional[Exception] = None
        for video_path in (video_a, video_b):
            _check_cancel(cancel_check)
            try:
                reader = factory(str(video_path))
                if reader is None:
                    raise OSError("reader_factory returned None")
                readers.append(reader)
                infos.append(_reader_info(reader))
            except Exception as exc:
                open_error = exc
                break
        if open_error is not None:
            for index, segment in enumerate(segment_values):
                output_segments.append(
                    _status_result(
                        index,
                        _safe_value(_segment_coarse(segment)),
                        "decode_error",
                        "reader_open_error:" + type(open_error).__name__,
                    )
                )
            return _result_payload(config, output_segments, state, started, cpu_started, clock, infos)

        source_duration = infos[0].get("duration")
        target_duration = infos[1].get("duration")
        for index, segment in enumerate(segment_values):
            coarse = _segment_coarse(segment)
            if index >= config.max_segments:
                output_segments.append(
                    _status_result(index, coarse, "budget_exceeded", "max_segments")
                )
                continue
            if state.stop_reason:
                output_segments.append(
                    _status_result(index, coarse, "budget_exceeded", state.stop_reason)
                )
                continue
            _check_cancel(cancel_check)
            if _elapsed(clock, started) >= config.max_wall_sec:
                state.stop_reason = "max_wall_sec"
                output_segments.append(
                    _status_result(index, coarse, "budget_exceeded", state.stop_reason)
                )
                continue

            bounds = _segment_bounds(segment)
            if bounds is None:
                output_segments.append(
                    _status_result(
                        index,
                        _safe_value(coarse),
                        "insufficient_evidence",
                        "invalid_segment_bounds",
                    )
                )
                continue
            source_start, source_end, target_start, target_end = bounds
            source_coarse = _clip_interval(source_start, source_end, source_duration)
            target_coarse = _clip_interval(target_start, target_end, target_duration)
            if source_coarse is None or target_coarse is None:
                output_segments.append(
                    _status_result(index, coarse, "insufficient_evidence", "empty_segment_after_clipping")
                )
                continue
            source_span = source_coarse.end - source_coarse.start
            target_span = target_coarse.end - target_coarse.start
            ratio = target_span / source_span
            if not 0.25 <= ratio <= 4.0 or not math.isfinite(ratio):
                output_segments.append(
                    _status_result(index, coarse, "insufficient_evidence", "unreasonable_time_scale")
                )
                continue
            source_window = _window(source_coarse, float(config.padding_sec), source_duration)
            target_window = _window(target_coarse, float(config.padding_sec), target_duration)
            try:
                sample_quotient = (
                    source_window.end - source_window.start
                ) / float(config.sample_step_sec)
            except (OverflowError, ZeroDivisionError):
                sample_quotient = float("inf")
            if not math.isfinite(sample_quotient) or sample_quotient > config.max_frames:
                state.stop_reason = "max_frames"
                output_segments.append(
                    _status_result(index, coarse, "budget_exceeded", state.stop_reason)
                )
                continue
            estimated_samples = max(1, int(math.ceil(sample_quotient)) + 1)
            # Refuse before materialising a potentially enormous timestamp
            # list. The minimum includes one source read and one target read
            # per sample, plus the second target pass for copy-mirror.
            # copy-mirror first tries the normal spatial hypothesis and only
            # spends another target pass when that hypothesis is insufficient.
            minimum_passes = 2
            if estimated_samples * minimum_passes > config.max_frames - state.attempts:
                state.stop_reason = "max_frames"
                output_segments.append(
                    _status_result(index, coarse, "budget_exceeded", state.stop_reason)
                )
                continue
            sample_times = _sample_times(source_window, float(config.sample_step_sec))
            source_samples: List[_SourceSample] = []
            source_errors = 0
            source_stopped = False
            last_source_timestamp: Optional[float] = None
            for timestamp in sample_times:
                outcome = _read_descriptor(
                    readers[0],
                    infos[0],
                    timestamp,
                    config,
                    preprocess_config,
                    state,
                    started,
                    clock,
                    cancel_check,
                )
                if outcome.status == "budget_exceeded":
                    source_stopped = True
                    break
                if outcome.status != "ok":
                    source_errors += 1
                    continue
                actual_source_timestamp = float(outcome.timestamp)
                if (
                    actual_source_timestamp < source_window.start - 1e-6
                    or actual_source_timestamp > source_window.end + 1e-6
                ):
                    source_errors += 1
                    continue
                if (
                    last_source_timestamp is not None
                    and actual_source_timestamp <= last_source_timestamp + 1e-9
                ):
                    # Repeated/descending actual timestamps cannot establish
                    # independent temporal support, even if every read works.
                    source_errors += 1
                    continue
                source_samples.append(
                    _SourceSample(
                        requested_timestamp=timestamp,
                        timestamp=actual_source_timestamp,
                        descriptor=outcome.descriptor,
                        timestamp_basis=outcome.timestamp_basis,
                    )
                )
                last_source_timestamp = actual_source_timestamp
            if source_stopped:
                output_segments.append(
                    _status_result(index, coarse, "budget_exceeded", state.stop_reason)
                )
                continue
            if not source_samples:
                output_segments.append(
                    _status_result(index, coarse, "decode_error", "no_source_frames")
                )
                continue

            directions = [False]
            if config.mode == "copy-mirror":
                directions.append(True)
            direction_results = []
            direction_stopped = False
            for mirror in directions:
                points, target_errors, stopped = _evaluate_direction(
                    source_samples,
                    readers[1],
                    infos[1],
                    source_coarse,
                    target_coarse,
                    source_window,
                    target_window,
                    ratio,
                    mirror,
                    config,
                    preprocess_config,
                    state,
                    started,
                    clock,
                    cancel_check,
                )
                if stopped:
                    output_segments.append(
                        _status_result(index, coarse, "budget_exceeded", state.stop_reason)
                    )
                    direction_stopped = True
                    break
                direction_result = _direction_evidence(
                    points,
                    config,
                    source_window,
                    target_window,
                    source_coarse,
                    target_coarse,
                    mirror,
                    ratio,
                    source_errors + target_errors,
                )
                direction_results.append(direction_result)
                # Once normal copy direction verifies the whole segment there
                # is no reason to spend a second target pass. Mirror is an
                # alternate spatial hypothesis, never a per-frame fusion.
                if direction_result["status"] == "verified":
                    break
                if _elapsed(clock, started) >= config.max_wall_sec:
                    state.stop_reason = "max_wall_sec"
                    output_segments.append(
                        _status_result(index, coarse, "budget_exceeded", state.stop_reason)
                    )
                    direction_stopped = True
                    break
            if not direction_stopped:
                if _elapsed(clock, started) >= config.max_wall_sec:
                    state.stop_reason = "max_wall_sec"
                    output_segments.append(
                        _status_result(index, coarse, "budget_exceeded", state.stop_reason)
                    )
                    continue
                selected = max(
                    direction_results,
                    key=lambda item: (
                        item["status"] == "verified",
                        item["evidence"].get("support_run_count", 0),
                        item["evidence"].get("mean_score", 0.0),
                    ),
                )
                output_segments.append(
                    _status_result(
                        index,
                        coarse,
                        selected["status"],
                        selected["reason"],
                        selected.get("proposal"),
                        selected.get("evidence"),
                        selected.get("proposal_adoptable"),
                    )
                )
    finally:
        for reader in reversed(readers):
            _close_reader(reader)

    return _result_payload(config, output_segments, state, started, cpu_started, clock, infos)


def _result_payload(
    config: RefinementConfig,
    output_segments: List[Dict[str, Any]],
    state: _BudgetState,
    started: float,
    cpu_started: float,
    clock: Callable[[], float],
    infos: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    elapsed = _elapsed(clock, started)
    bases = [info.get("timestamp_basis", "unknown") for info in infos]
    while len(bases) < 2:
        bases.append("unknown")
    return {
        "version": SEGMENT_REFINEMENT_VERSION,
        "mode": config.mode,
        "config": config.to_dict(),
        "segments": output_segments,
        "metrics": {
            "frames_decoded": int(state.frames_decoded),
            "frame_attempts": int(state.attempts),
            "pixels_decoded": int(state.pixels_decoded),
            "elapsed_ms": float(elapsed * 1000.0),
            "cpu_ms": float(max(0.0, time.process_time() - cpu_started) * 1000.0),
            "segments_processed": sum(
                1
                for segment in output_segments
                if segment["reason"] != "max_segments"
            ),
            "timestamp_basis": {"source": str(bases[0]), "target": str(bases[1])},
        },
    }


def refinement_failure_payload(
    segments: Sequence[Any],
    *,
    config: RefinementConfig,
    reason: str,
) -> Dict[str, Any]:
    """Build structured additive evidence when an optional run-time error occurs.

    Entrypoints use this for unexpected decoder/import errors around the core
    call. It deliberately does not open media and keeps every coarse segment
    visible, so an enabled-but-failed refinement is distinguishable from the
    default-off ``None`` value.
    """

    if not isinstance(config, RefinementConfig):
        raise TypeError("config must be a RefinementConfig")
    values = _coerce_segments(segments)
    normalized_reason = str(reason).strip() or "unknown_error"
    return {
        "version": SEGMENT_REFINEMENT_VERSION,
        "mode": config.mode,
        "config": config.to_dict(),
        "segments": [
            _status_result(
                index,
                _safe_value(_segment_coarse(segment)),
                "decode_error",
                "refinement_error:" + normalized_reason,
            )
            for index, segment in enumerate(values)
        ],
        "metrics": {
            "frames_decoded": 0,
            "frame_attempts": 0,
            "pixels_decoded": 0,
            "elapsed_ms": 0.0,
            "cpu_ms": 0.0,
            "segments_processed": 0,
            "timestamp_basis": {"source": "unknown", "target": "unknown"},
            "error": normalized_reason,
        },
    }


__all__ = [
    "MIN_TRANSITION_COSINE",
    "MIN_CONSISTENT_TRANSITION_RATIO",
    "MAX_REFINEMENT_FRAMES",
    "MAX_REFINEMENT_SEGMENTS",
    "MAX_REFINEMENT_INPUT_SEGMENTS",
    "RefinementConfig",
    "SEGMENT_REFINEMENT_VERSION",
    "refinement_failure_payload",
    "refine_segments",
]
