"""Deterministic, bounded-window scheduling for video comparison pairs.

The scheduler only changes the order in which already-created work items are
visited.  It does not rewrite a pair's direction, report ordinal, or any of
its metadata.  A small finite window keeps reordering bounded while allowing
the next pair to reuse an endpoint that is predicted to still be resident.

The counters returned by :func:`schedule_diagnostics` are a sequential LRU
model for benchmarking.  They do not describe the timing or contention of a
concurrent resource pool.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import operator
import os
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class PairWorkItem:
    """One comparison pair, retaining the caller's original pair direction."""

    report_ordinal: int
    video_a: Path
    video_b: Path
    key: str = ""
    units: float = 1.0


def _as_int(value: int, *, name: str) -> int:
    """Convert an integer-like argument without silently truncating floats."""

    try:
        converted = operator.index(value)
    except TypeError as exc:
        raise TypeError(f"{name} must be an integer") from exc
    return int(converted)


def _canonical_path(path: Path) -> str:
    """Return a comparison-only path identity.

    ``resolve(strict=False)`` makes relative spellings comparable without
    requiring the video to exist.  ``normcase`` supplies the platform's path
    case and separator rules (notably case-insensitive Windows paths).  The
    returned string is never written back to a work item.
    """

    try:
        resolved = Path(path).resolve(strict=False)
    except (OSError, RuntimeError):
        # A malformed/unavailable path should still have a deterministic
        # identity for validation and sorting.
        resolved = Path(path)
    return os.path.normcase(str(resolved))


def _validated_items(items: Iterable[PairWorkItem]) -> tuple[list[PairWorkItem], list[tuple[str, str]]]:
    """Materialize and validate items, returning their canonical endpoints."""

    try:
        materialized = list(items)
    except TypeError as exc:
        raise TypeError("items must be an iterable of PairWorkItem") from exc

    ordinals: set[int] = set()
    pair_ids: set[tuple[str, str]] = set()
    endpoints: list[tuple[str, str]] = []
    for item in materialized:
        if not isinstance(item, PairWorkItem):
            raise TypeError("items must contain only PairWorkItem instances")

        ordinal = item.report_ordinal
        if isinstance(ordinal, bool) or not isinstance(ordinal, int):
            raise TypeError("report_ordinal must be an integer")
        if ordinal < 0:
            raise ValueError("report_ordinal must be non-negative")
        if ordinal in ordinals:
            raise ValueError(f"duplicate report_ordinal: {ordinal}")
        ordinals.add(ordinal)

        endpoint_a = _canonical_path(item.video_a)
        endpoint_b = _canonical_path(item.video_b)
        if endpoint_a == endpoint_b:
            raise ValueError("self-pairs are not allowed")
        pair_id = tuple(sorted((endpoint_a, endpoint_b)))
        if pair_id in pair_ids:
            raise ValueError("duplicate unordered video pair")
        pair_ids.add(pair_id)
        endpoints.append((endpoint_a, endpoint_b))

    return materialized, endpoints


def _touch_lru(lru: OrderedDict[str, None], endpoints: tuple[str, str], capacity: int) -> int:
    """Access endpoints in pair order and return the number evicted."""

    evictions = 0
    for endpoint in endpoints:
        if endpoint in lru:
            lru.move_to_end(endpoint)
        else:
            lru[endpoint] = None
            if len(lru) > capacity:
                lru.popitem(last=False)
                evictions += 1
    return evictions


def schedule_pairs_for_locality(
    items: Iterable[PairWorkItem],
    *,
    window_size: int,
    resident_capacity: int,
) -> list[PairWorkItem]:
    """Schedule pair work in deterministic contiguous input windows.

    Each window is processed completely before the next one is made visible to
    the chooser.  At every step the candidate with the most endpoints in the
    predicted LRU is selected.  Ties prefer candidates with more still
    unscheduled neighbours in the current window, then lower report ordinal,
    then canonical endpoint strings.  LRU state survives window boundaries.
    """

    materialized, endpoints = _validated_items(items)
    window = _as_int(window_size, name="window_size")
    capacity = _as_int(resident_capacity, name="resident_capacity")
    if capacity < 2:
        raise ValueError("resident_capacity must be at least 2")
    if window <= 1 or len(materialized) < 2:
        return list(materialized)

    lru: OrderedDict[str, None] = OrderedDict()
    scheduled: list[PairWorkItem] = []

    for start in range(0, len(materialized), window):
        stop = min(start + window, len(materialized))
        pending = set(range(start, stop))

        # Endpoint degrees let us calculate the continuation tie-break in
        # O(1) per endpoint while keeping all choices local to this window.
        endpoint_counts: dict[str, int] = {}
        for index in pending:
            for endpoint in endpoints[index]:
                endpoint_counts[endpoint] = endpoint_counts.get(endpoint, 0) + 1

        while pending:
            def choice_key(index: int) -> tuple[int, int, int, str, str]:
                endpoint_a, endpoint_b = endpoints[index]
                shared = int(endpoint_a in lru) + int(endpoint_b in lru)
                continuation = (
                    endpoint_counts[endpoint_a]
                    - 1
                    + endpoint_counts[endpoint_b]
                    - 1
                )
                item = materialized[index]
                return (
                    -shared,
                    -continuation,
                    item.report_ordinal,
                    endpoint_a,
                    endpoint_b,
                )

            selected = min(pending, key=choice_key)
            pending.remove(selected)
            endpoint_a, endpoint_b = endpoints[selected]
            endpoint_counts[endpoint_a] -= 1
            endpoint_counts[endpoint_b] -= 1
            scheduled.append(materialized[selected])
            _touch_lru(lru, (endpoint_a, endpoint_b), capacity)

    return scheduled


def _require_same_items(
    original: list[PairWorkItem],
    scheduled: list[PairWorkItem],
) -> None:
    """Ensure diagnostics are comparing an order-only permutation."""

    if len(original) != len(scheduled):
        raise ValueError("scheduled items must contain the same work items")
    original_ids = {id(item) for item in original}
    scheduled_ids = [id(item) for item in scheduled]
    if len(set(scheduled_ids)) != len(scheduled_ids) or set(scheduled_ids) != original_ids:
        raise ValueError("scheduled items must preserve input identity exactly")


def schedule_diagnostics(
    original: Iterable[PairWorkItem],
    scheduled: Iterable[PairWorkItem],
    resident_capacity: int,
) -> dict[str, int]:
    """Return sequential LRU estimates for a scheduled permutation.

    ``predicted_loads`` counts endpoint access requests (two per pair), while
    misses and hits partition those requests.  Evictions count endpoint
    insertions that overflow the modeled LRU.  The model is intentionally
    diagnostic only and makes no claim about concurrent ``ExactResourcePool``
    counters.
    """

    original_items, _ = _validated_items(original)
    scheduled_items, scheduled_endpoints = _validated_items(scheduled)
    _require_same_items(original_items, scheduled_items)
    capacity = _as_int(resident_capacity, name="resident_capacity")
    if capacity < 2:
        raise ValueError("resident_capacity must be at least 2")

    shared_transitions = 0
    for previous, current in zip(scheduled_endpoints, scheduled_endpoints[1:]):
        if set(previous).intersection(current):
            shared_transitions += 1

    lru: OrderedDict[str, None] = OrderedDict()
    loads = hits = misses = evictions = 0
    for pair_endpoints in scheduled_endpoints:
        for endpoint in pair_endpoints:
            loads += 1
            if endpoint in lru:
                hits += 1
                lru.move_to_end(endpoint)
            else:
                misses += 1
                lru[endpoint] = None
                if len(lru) > capacity:
                    lru.popitem(last=False)
                    evictions += 1

    return {
        "pairs": len(scheduled_items),
        "shared_endpoint_transitions": shared_transitions,
        "predicted_loads": loads,
        "predicted_misses": misses,
        "predicted_hits": hits,
        "predicted_evictions": evictions,
    }


__all__ = [
    "PairWorkItem",
    "schedule_pairs_for_locality",
    "schedule_diagnostics",
]
