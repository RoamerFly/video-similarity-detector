"""Lightweight, JSON-serializable metrics for recognition runs.

The recognition pipeline is intentionally quiet during hot loops.  Callers
record a stage once per meaningful unit (video, pair, or batch) and this
module aggregates elapsed time and counters without requiring psutil or a
CUDA installation.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import sys
import threading
import time
from typing import Dict, Iterable, Iterator, Optional


STAGE_NAMES = (
    "decode_sample",
    "preprocess",
    "embed",
    "candidate",
    "exact_compare",
    "segment",
)


@dataclass
class StageMetric:
    """Accumulated worker timing and work counters for one pipeline stage.

    Stage timers are additive by design.  When comparison workers run in
    parallel, ``elapsed_ms``/``accumulated_elapsed_ms`` therefore represent
    total worker time, not wall-clock duration.
    """

    elapsed_ms: float = 0.0
    calls: int = 0
    items: int = 0

    def to_dict(self) -> dict:
        accumulated = round(max(0.0, float(self.elapsed_ms)), 3)
        return {
            # Keep elapsed_ms for existing consumers; the explicit field and
            # aggregation marker remove ambiguity for new consumers.
            "elapsed_ms": accumulated,
            "accumulated_elapsed_ms": accumulated,
            "aggregation": "accumulated",
            "calls": int(self.calls),
            "items": int(self.items),
        }

    @classmethod
    def from_dict(cls, value: object) -> "StageMetric":
        if not isinstance(value, dict):
            return cls()
        return cls(
            elapsed_ms=float(value.get("elapsed_ms", 0.0) or 0.0),
            calls=max(0, int(value.get("calls", 0) or 0)),
            items=max(0, int(value.get("items", 0) or 0)),
        )


@dataclass
class RecognitionMetrics:
    """Run-level metrics with tolerant JSON serialization.

    RSS is sampled at stage boundaries. ``baseline_rss_bytes`` is captured
    during construction, while ``observed_peak_rss_bytes`` is the largest
    process peak observed afterwards and ``peak_rss_delta_bytes`` is the
    non-negative difference between them. ``peak_rss_bytes`` remains as a
    backwards-compatible alias for the observed peak. CUDA memory values are
    best-effort and remain empty on CPU-only installations.
    """

    stages: Dict[str, StageMetric] = field(
        default_factory=lambda: {name: StageMetric() for name in STAGE_NAMES}
    )
    counters: Dict[str, int] = field(default_factory=dict)
    baseline_rss_bytes: Optional[int] = None
    current_rss_bytes: Optional[int] = None
    observed_peak_rss_bytes: Optional[int] = None
    peak_rss_delta_bytes: Optional[int] = None
    # Deprecated alias retained for old report consumers and callers.
    peak_rss_bytes: Optional[int] = None
    cuda: Dict[str, object] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)
    _started_monotonic: Optional[float] = field(default=None, init=False, repr=False, compare=False)
    wall_elapsed_ms: Optional[float] = None

    def __post_init__(self) -> None:
        for name in STAGE_NAMES:
            self.stages.setdefault(name, StageMetric())
        if self.observed_peak_rss_bytes is None and self.peak_rss_bytes is not None:
            self.observed_peak_rss_bytes = max(0, int(self.peak_rss_bytes))
        if self.wall_elapsed_ms is None:
            self._started_monotonic = time.perf_counter()
        self.snapshot_resources()

    @contextmanager
    def stage(self, name: str, items: int = 0) -> Iterator[None]:
        """Measure one stage without emitting per-iteration log messages."""

        started = time.perf_counter()
        try:
            yield
        finally:
            self.record_stage(name, time.perf_counter() - started, items=items)

    def record_stage(self, name: str, elapsed_seconds: float, items: int = 0) -> None:
        metric = self.stages.setdefault(str(name), StageMetric())
        with self._lock:
            metric.elapsed_ms += max(0.0, float(elapsed_seconds)) * 1000.0
            metric.calls += 1
            metric.items += max(0, int(items))
        self.snapshot_resources()

    def add_elapsed(self, name: str, elapsed_seconds: float, items: int = 0) -> None:
        """Alias for accumulating a timer owned by a caller hot loop."""

        self.record_stage(name, elapsed_seconds, items=items)

    def add_elapsed_batch(self, records: Iterable[tuple[str, float, int]]) -> None:
        """Accumulate several stage records with one resource snapshot.

        Each tuple is ``(name, elapsed_seconds, items)``. Every entry has the
        same clamping and call-count behavior as :meth:`record_stage`; repeated
        names therefore create repeated calls while accumulating into the same
        ``StageMetric``. An empty batch does nothing and does not sample
        resources.
        """

        normalized = [
            (
                str(name),
                max(0.0, float(elapsed_seconds)),
                max(0, int(items)),
            )
            for name, elapsed_seconds, items in records
        ]
        if not normalized:
            return
        with self._lock:
            for name, elapsed_seconds, items in normalized:
                metric = self.stages.setdefault(name, StageMetric())
                metric.elapsed_ms += elapsed_seconds * 1000.0
                metric.calls += 1
                metric.items += items
        self.snapshot_resources()

    def count(self, name: str, amount: int = 1) -> None:
        with self._lock:
            self.counters[str(name)] = self.counters.get(str(name), 0) + max(0, int(amount))

    def set_count(self, name: str, amount: int) -> None:
        with self._lock:
            self.counters[str(name)] = max(0, int(amount))

    def snapshot_resources(self) -> None:
        memory = process_memory_snapshot()
        current = memory.get("current_rss_bytes")
        observed = memory.get("peak_rss_bytes")
        with self._lock:
            if current is not None:
                self.current_rss_bytes = int(current)
            if self.baseline_rss_bytes is None:
                baseline = current if current is not None else observed
                if baseline is not None:
                    self.baseline_rss_bytes = max(0, int(baseline))
            if observed is None:
                observed = current
            if observed is not None:
                self.observed_peak_rss_bytes = max(
                    int(self.observed_peak_rss_bytes or 0), int(observed)
                )
            if self.baseline_rss_bytes is not None and self.observed_peak_rss_bytes is not None:
                self.peak_rss_delta_bytes = max(
                    0,
                    int(self.observed_peak_rss_bytes) - int(self.baseline_rss_bytes),
                )
            self.peak_rss_bytes = self.observed_peak_rss_bytes

        cuda = cuda_memory_snapshot()
        if cuda:
            with self._lock:
                self.cuda.update(cuda)

    def to_dict(self) -> dict:
        self.snapshot_resources()
        with self._lock:
            if self._started_monotonic is not None:
                self.wall_elapsed_ms = max(
                    0.0,
                    (time.perf_counter() - self._started_monotonic) * 1000.0,
                )
            return {
                "schema_version": 1,
                "stages": {name: metric.to_dict() for name, metric in self.stages.items()},
                "counters": dict(self.counters),
                "baseline_rss_bytes": self.baseline_rss_bytes,
                "current_rss_bytes": self.current_rss_bytes,
                "observed_peak_rss_bytes": self.observed_peak_rss_bytes,
                "peak_rss_delta_bytes": self.peak_rss_delta_bytes,
                # Deprecated alias; it intentionally has the observed-peak
                # meaning, not the net allocation delta.
                "peak_rss_bytes": self.peak_rss_bytes,
                "cuda": dict(self.cuda),
                "wall_elapsed_ms": (
                    round(max(0.0, float(self.wall_elapsed_ms)), 3)
                    if self.wall_elapsed_ms is not None else None
                ),
                "stage_timing_aggregation": "accumulated_worker_time",
            }

    @classmethod
    def from_dict(cls, value: object) -> "RecognitionMetrics":
        if not isinstance(value, dict):
            return cls()
        stages = {
            str(name): StageMetric.from_dict(stage)
            for name, stage in (value.get("stages") or {}).items()
        } if isinstance(value.get("stages"), dict) else {}
        counters = value.get("counters") if isinstance(value.get("counters"), dict) else {}
        observed_peak = value.get("observed_peak_rss_bytes")
        if observed_peak is None:
            observed_peak = value.get("peak_rss_bytes")
        return cls(
            stages=stages,
            counters={str(key): max(0, int(item or 0)) for key, item in counters.items()},
            baseline_rss_bytes=(
                max(0, int(value["baseline_rss_bytes"]))
                if value.get("baseline_rss_bytes") is not None else None
            ),
            current_rss_bytes=(
                max(0, int(value["current_rss_bytes"]))
                if value.get("current_rss_bytes") is not None else None
            ),
            observed_peak_rss_bytes=(
                max(0, int(observed_peak)) if observed_peak is not None else None
            ),
            peak_rss_delta_bytes=(
                max(0, int(value["peak_rss_delta_bytes"]))
                if value.get("peak_rss_delta_bytes") is not None else None
            ),
            peak_rss_bytes=(
                max(0, int(value["peak_rss_bytes"]))
                if value.get("peak_rss_bytes") is not None else None
            ),
            cuda=dict(value.get("cuda") or {}) if isinstance(value.get("cuda"), dict) else {},
            wall_elapsed_ms=(
                max(0.0, float(value["wall_elapsed_ms"]))
                if value.get("wall_elapsed_ms") is not None else None
            ),
        )

    def save_json(self, path: os.PathLike[str] | str) -> Path:
        output = Path(path)
        output.parent.mkdir(parents=True, exist_ok=True)
        pending = output.with_name(f"{output.name}.tmp")
        pending.write_text(json.dumps(self.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
        pending.replace(output)
        return output


def _resource_peak_rss_bytes(value: int, platform_name: Optional[str] = None) -> int:
    """Normalize ``resource.ru_maxrss`` to bytes for the given platform."""

    # Linux and most BSDs report KiB; macOS reports bytes.
    return int(value) if (platform_name or sys.platform) == "darwin" else int(value) * 1024


def _psutil_memory_snapshot(platform_name: str) -> Dict[str, int]:
    try:
        import psutil  # type: ignore

        info = psutil.Process().memory_info()
        snapshot = {"current_rss_bytes": int(info.rss)}
        # Windows psutil exposes peak_wset; Linux/macOS generally do not.
        peak_wset = getattr(info, "peak_wset", None) if platform_name == "nt" else None
        if peak_wset is not None:
            snapshot["peak_rss_bytes"] = int(peak_wset)
        return snapshot
    except Exception:
        return {}


def _windows_memory_snapshot() -> Dict[str, int]:
    """Read current and peak working-set sizes through the Windows API."""

    try:
        import ctypes
        from ctypes import wintypes

        class _ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("page_fault_count", ctypes.c_ulong),
                ("peak_working_set_size", ctypes.c_size_t),
                ("working_set_size", ctypes.c_size_t),
                ("quota_peak_paged_pool_usage", ctypes.c_size_t),
                ("quota_paged_pool_usage", ctypes.c_size_t),
                ("quota_peak_non_paged_pool_usage", ctypes.c_size_t),
                ("quota_non_paged_pool_usage", ctypes.c_size_t),
                ("pagefile_usage", ctypes.c_size_t),
                ("peak_pagefile_usage", ctypes.c_size_t),
            ]

        counters = _ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        # Set the WinAPI signature explicitly.  The bundled/embedded Python
        # runtime does not always infer the pointer argument correctly from
        # ``ctypes.windll``; without argtypes the call returns FALSE and all
        # recognition metrics silently lose their RSS fields.
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        get_current_process = kernel32.GetCurrentProcess
        get_current_process.argtypes = []
        get_current_process.restype = wintypes.HANDLE
        get_process_memory_info = psapi.GetProcessMemoryInfo
        get_process_memory_info.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(_ProcessMemoryCounters),
            wintypes.DWORD,
        ]
        get_process_memory_info.restype = wintypes.BOOL
        process = get_current_process()
        ok = get_process_memory_info(process, ctypes.byref(counters), counters.cb)
        if ok:
            return {
                "current_rss_bytes": int(counters.working_set_size),
                "peak_rss_bytes": int(counters.peak_working_set_size),
            }
    except Exception:
        pass
    return {}


def process_memory_snapshot(
    platform_name: Optional[str] = None,
    system_name: Optional[str] = None,
) -> Dict[str, int]:
    """Return current and process-peak RSS in bytes when available.

    ``platform_name`` and ``system_name`` are injectable for deterministic
    cross-platform tests; normal callers leave them unset.
    """

    platform_name = platform_name or os.name
    system_name = system_name or sys.platform
    snapshot = _psutil_memory_snapshot(platform_name)
    if platform_name == "nt":
        windows = _windows_memory_snapshot()
        for key, value in windows.items():
            snapshot.setdefault(key, value)
        return snapshot

    try:
        import resource

        peak = _resource_peak_rss_bytes(
            int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss),
            system_name,
        )
        snapshot["peak_rss_bytes"] = max(
            int(snapshot.get("peak_rss_bytes", 0)),
            peak,
        )
    except Exception:
        pass
    if "current_rss_bytes" not in snapshot and "peak_rss_bytes" in snapshot:
        # ``ru_maxrss`` is a peak, not current RSS; use it only as a clearly
        # labelled fallback when no current-process API is available.
        snapshot["current_rss_bytes"] = snapshot["peak_rss_bytes"]
    return snapshot


def current_rss_bytes() -> Optional[int]:
    """Return current RSS, retaining the original lightweight helper API."""

    return process_memory_snapshot().get("current_rss_bytes")


def cuda_memory_snapshot() -> Dict[str, object]:
    """Return CUDA allocation counters without requiring CUDA at import time."""

    try:
        import torch

        if not torch.cuda.is_available():
            return {}
        return {
            "available": True,
            "device": torch.cuda.current_device(),
            "allocated_bytes": int(torch.cuda.memory_allocated()),
            "reserved_bytes": int(torch.cuda.memory_reserved()),
            "peak_allocated_bytes": int(torch.cuda.max_memory_allocated()),
        }
    except Exception:
        return {}
