"""Bounded, thread-safe lifetime management for exact comparison resources."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import os
from pathlib import Path
from threading import Condition, Lock
import sys
import time
from typing import Callable, Iterator

import numpy as np

from video_sim.embedder import FrameEmbeddingCache
from video_sim.indexer import FrameIndexResult, build_frame_index


@dataclass
class ExactResource:
    cache: FrameEmbeddingCache
    frame_index: FrameIndexResult


@dataclass
class _PoolEntry:
    loading: bool = True
    resource: ExactResource | None = None
    refcount: int = 0
    last_used: float = 0.0
    estimated_bytes: int = 0


class ExactResourcePool:
    """Load exact resources under video-count and optional byte budgets.

    A pair lease pins both cache/index entries for its whole comparison.  A
    cache requested concurrently by several workers is loaded once; later
    callers wait for that load and share the same object.  Only unpinned
    entries are eligible for LRU eviction.  The byte budget is opt-in so
    existing callers keep their previous residency behavior unless they pass
    ``max_resident_bytes`` or set ``VIDEO_SIM_EXACT_CACHE_BYTES``.
    """

    def __init__(
        self,
        max_resident_videos: int | None = None,
        max_resident_bytes: int | None = None,
        cache_loader: Callable[[Path], FrameEmbeddingCache] | None = None,
        index_builder: Callable[[FrameEmbeddingCache], FrameIndexResult] | None = None,
    ) -> None:
        configured = max_resident_videos
        if configured is None:
            raw = os.environ.get("VIDEO_SIM_EXACT_CACHE_VIDEOS", "").strip()
            configured = int(raw) if raw.isdigit() else 2
        self.max_resident_videos = max(2, int(configured or 2))
        configured_bytes = max_resident_bytes
        if configured_bytes is None:
            raw_bytes = os.environ.get("VIDEO_SIM_EXACT_CACHE_BYTES", "").strip()
            try:
                configured_bytes = int(raw_bytes) if raw_bytes else None
            except ValueError:
                configured_bytes = None
        self.max_resident_bytes = (
            int(configured_bytes) if configured_bytes is not None and int(configured_bytes) > 0 else None
        )
        self.cache_loader = cache_loader or FrameEmbeddingCache.load
        self.index_builder = index_builder or build_frame_index
        self._condition = Condition(Lock())
        self._entries: dict[str, _PoolEntry] = {}
        self._hits = 0
        self._misses = 0
        self._evictions = 0
        self._peak_resident_videos = 0
        self._peak_estimated_bytes = 0
        self._oversized_pair_or_resource = 0

    @staticmethod
    def _key(path: str | Path) -> str:
        return str(Path(path).resolve(strict=False)).casefold()

    def _resident_count_locked(self) -> int:
        return sum(1 for entry in self._entries.values() if entry.resource is not None or entry.loading)

    def _resident_bytes_locked(self) -> int:
        return sum(
            int(entry.estimated_bytes)
            for entry in self._entries.values()
            if entry.resource is not None
        )

    @staticmethod
    def _estimate_resource_bytes(resource: ExactResource) -> int:
        """Estimate resident NumPy/FAISS storage without copying large arrays.

        ``build_frame_index`` keeps the cache arrays and FAISS's own vector
        matrix alive at the same time.  It also copies frame metadata into the
        index result, so those arrays are included as well.  Strings are
        counted by their encoded payload and Python object size; this is an
        intentionally conservative estimate for phashes and legacy thumbnail
        paths.
        """

        cache = resource.cache
        total = 0
        counted_array_ids: set[int] = set()
        for value in (
            getattr(cache, "embeddings", None),
            getattr(cache, "timestamps", None),
            getattr(cache, "frame_indices", None),
        ):
            if value is not None:
                array_id = id(value)
                if array_id in counted_array_ids:
                    continue
                counted_array_ids.add(array_id)
                total += int(np.asarray(value).nbytes)

        for value in (
            getattr(resource.frame_index, "timestamps", None),
            getattr(resource.frame_index, "frame_indices", None),
        ):
            if value is not None:
                array_id = id(value)
                if array_id in counted_array_ids:
                    continue
                counted_array_ids.add(array_id)
                total += int(np.asarray(value).nbytes)

        counted_sequence_ids: set[int] = set()
        for values in (
            getattr(cache, "phashes", None),
            getattr(cache, "thumbnail_paths", None),
            # ``build_frame_index`` copies this list, so it is a separate
            # resident allocation even when it contains the same strings.
            getattr(resource.frame_index, "thumbnail_paths", None),
        ):
            if values is None:
                continue
            sequence_id = id(values)
            if sequence_id in counted_sequence_ids:
                continue
            counted_sequence_ids.add(sequence_id)
            total += int(sys.getsizeof(values))
            for value in values:
                try:
                    encoded_size = len(str(value).encode("utf-8", errors="replace"))
                except Exception:
                    encoded_size = 0
                total += int(sys.getsizeof(value)) + encoded_size

        index = resource.frame_index.index
        ntotal = int(getattr(index, "ntotal", 0) or 0)
        dimension = int(getattr(index, "d", 0) or 0)
        total += ntotal * dimension * 4
        return max(0, int(total))

    def _make_room_locked(
        self,
        additional_slots: int = 1,
        protected_keys: set[str] | None = None,
    ) -> None:
        required = int(additional_slots)
        if required <= 0:
            return
        protected = protected_keys or set()
        while self._resident_count_locked() + required > self.max_resident_videos:
            candidates = [
                (key, entry)
                for key, entry in self._entries.items()
                if (
                    key not in protected
                    and not entry.loading
                    and entry.resource is not None
                    and entry.refcount == 0
                )
            ]
            if not candidates:
                self._condition.wait()
                continue
            key, _ = min(candidates, key=lambda item: item[1].last_used)
            del self._entries[key]
            self._evictions += 1

    def _make_room_for_bytes_locked(
        self,
        additional_bytes: int,
        *,
        protected_keys: set[str] | None = None,
        pair_lease: bool = False,
    ) -> bool:
        """Evict/wait for byte capacity and return whether a soft overage was used.

        The resource is loaded and indexed before this method is called, so no
        condition lock is held during expensive I/O or FAISS construction.
        A resource larger than the whole budget, and the aggregate of a
        protected pair larger than the budget, are admitted after evicting all
        possible LRU entries.  This prevents a lease from waiting forever for
        capacity it can never satisfy.
        """

        capacity = self.max_resident_bytes
        if capacity is None:
            return False
        required = max(0, int(additional_bytes))
        protected = protected_keys or set()
        soft_overage = required > capacity
        while self._resident_bytes_locked() + required > capacity:
            candidates = [
                (key, entry)
                for key, entry in self._entries.items()
                if (
                    key not in protected
                    and not entry.loading
                    and entry.resource is not None
                    and entry.refcount == 0
                )
            ]
            if candidates:
                key, _ = min(candidates, key=lambda item: item[1].last_used)
                del self._entries[key]
                self._evictions += 1
                continue

            if soft_overage:
                return True

            if pair_lease:
                protected_bytes = sum(
                    int(entry.estimated_bytes)
                    for key, entry in self._entries.items()
                    if key in protected and entry.resource is not None
                )
                other_load_in_progress = any(
                    key not in protected and entry.loading
                    for key, entry in self._entries.items()
                )
                # The pair itself cannot fit even after every unpinned
                # unrelated entry has been evicted.  Admit it as a bounded,
                # observable soft overage; unrelated pinned work may still
                # legitimately require waiting here.
                # If another pair is still loading, allowing this pair to
                # publish lets that loader finish and prevents two pair
                # reservations from waiting on each other's unknown size.
                if protected_bytes + required > capacity or other_load_in_progress:
                    return True

            self._condition.wait()
        return False

    def _publish_loaded_locked(
        self,
        key: str,
        resource: ExactResource,
        estimated_bytes: int,
        *,
        protected_keys: set[str] | None = None,
        pair_lease: bool = False,
    ) -> bool:
        soft_overage = self._make_room_for_bytes_locked(
            estimated_bytes,
            protected_keys=protected_keys,
            pair_lease=pair_lease,
        )
        entry = self._entries[key]
        entry.loading = False
        entry.resource = resource
        entry.estimated_bytes = max(0, int(estimated_bytes))
        entry.refcount = 1
        entry.last_used = time.monotonic()
        resident_bytes = self._resident_bytes_locked()
        self._peak_estimated_bytes = max(self._peak_estimated_bytes, resident_bytes)
        self._peak_resident_videos = max(
            self._peak_resident_videos,
            self._resident_count_locked(),
        )
        self._condition.notify_all()
        return soft_overage

    def _acquire_one(self, path: str | Path) -> ExactResource:
        key = self._key(path)
        while True:
            with self._condition:
                entry = self._entries.get(key)
                if entry is not None:
                    if entry.loading:
                        self._condition.wait()
                        continue
                    if entry.resource is not None:
                        entry.refcount += 1
                        entry.last_used = time.monotonic()
                        self._hits += 1
                        return entry.resource
                self._make_room_locked()
                entry = _PoolEntry(loading=True, last_used=time.monotonic())
                self._entries[key] = entry
                self._misses += 1
                break

        try:
            cache = self.cache_loader(Path(path))
            resource = ExactResource(cache=cache, frame_index=self.index_builder(cache))
            estimated_bytes = self._estimate_resource_bytes(resource)
            with self._condition:
                soft_overage = self._publish_loaded_locked(key, resource, estimated_bytes)
                if soft_overage:
                    self._oversized_pair_or_resource += 1
            return resource
        except BaseException:
            with self._condition:
                self._entries.pop(key, None)
                self._condition.notify_all()
            raise

    def _release_one(self, path: str | Path) -> None:
        key = self._key(path)
        with self._condition:
            entry = self._entries.get(key)
            if entry is None or entry.loading:
                return
            entry.refcount = max(0, entry.refcount - 1)
            entry.last_used = time.monotonic()
            self._condition.notify_all()

    @contextmanager
    def acquire(self, path: str | Path) -> Iterator[ExactResource]:
        resource = self._acquire_one(path)
        try:
            yield resource
        finally:
            self._release_one(path)

    @contextmanager
    def acquire_pair(
        self,
        path_a: str | Path,
        path_b: str | Path,
    ) -> Iterator[tuple[ExactResource, ExactResource]]:
        # Reserve both slots atomically.  Stable ordering makes the returned
        # resources deterministic, while the reservation itself prevents the
        # classic A/C versus B/D deadlock when capacity is two.
        paths = [Path(path_a), Path(path_b)]
        unique_keys = sorted({self._key(path) for path in paths})
        path_by_key = {self._key(path): path for path in paths}
        resources_by_key: dict[str, ExactResource] = {}
        new_keys: list[str] = []
        while True:
            with self._condition:
                existing_loading = any(
                    (entry := self._entries.get(key)) is not None and entry.loading
                    for key in unique_keys
                )
                if existing_loading:
                    self._condition.wait()
                    continue
                new_keys = [key for key in unique_keys if key not in self._entries]
                # Keep already-resident members of this pair pinned while
                # making room for the missing member(s).  Without this
                # protection an LRU tie can evict the shared left/right
                # resource, then the lookup below raises KeyError.
                self._make_room_locked(len(new_keys), protected_keys=set(unique_keys))
                for key in new_keys:
                    self._entries[key] = _PoolEntry(
                        loading=True,
                        last_used=time.monotonic(),
                    )
                    self._misses += 1
                for key in unique_keys:
                    if key not in new_keys:
                        entry = self._entries[key]
                        if entry.resource is None:
                            raise RuntimeError(f"resource entry is not loadable: {key}")
                        entry.refcount += 1
                        entry.last_used = time.monotonic()
                        self._hits += 1
                break

        try:
            pair_soft_overage = False
            for key in new_keys:
                path = path_by_key[key]
                cache = self.cache_loader(path)
                resource = ExactResource(cache=cache, frame_index=self.index_builder(cache))
                estimated_bytes = self._estimate_resource_bytes(resource)
                with self._condition:
                    pair_soft_overage = (
                        self._publish_loaded_locked(
                        key,
                        resource,
                        estimated_bytes,
                        protected_keys=set(unique_keys),
                        pair_lease=True,
                        )
                        or pair_soft_overage
                    )
                resources_by_key[key] = resource
            for key in unique_keys:
                if key not in resources_by_key:
                    entry = self._entries[key]
                    if entry.resource is None:
                        raise RuntimeError(f"resource entry disappeared: {key}")
                    resources_by_key[key] = entry.resource
            with self._condition:
                pair_bytes = sum(
                    int(self._entries[key].estimated_bytes)
                    for key in unique_keys
                    if key in self._entries and self._entries[key].resource is not None
                )
                if self.max_resident_bytes is not None and (
                    pair_bytes > self.max_resident_bytes or pair_soft_overage
                ):
                    self._oversized_pair_or_resource += 1
            yield resources_by_key[self._key(paths[0])], resources_by_key[self._key(paths[1])]
        except BaseException:
            with self._condition:
                for key in unique_keys:
                    entry = self._entries.get(key)
                    if entry is None:
                        continue
                    if key in new_keys and entry.loading:
                        self._entries.pop(key, None)
                self._condition.notify_all()
            raise
        finally:
            with self._condition:
                for key in unique_keys:
                    entry = self._entries.get(key)
                    if entry is not None and entry.resource is not None:
                        entry.refcount = max(0, entry.refcount - 1)
                        entry.last_used = time.monotonic()
                self._condition.notify_all()

    def stats(self) -> dict[str, int]:
        """Return pool counters and the published-residency byte estimate.

        ``byte_capacity`` applies after a resource has finished loading and
        indexing.  Loading entries have unknown decompressed sizes and are
        bounded by ``max_resident_videos`` during that interval, so this
        estimate is not a hard process-RSS limit for in-flight loads.
        """

        with self._condition:
            resident = [entry for entry in self._entries.values() if entry.resource is not None]
            estimated_bytes = sum(int(entry.estimated_bytes) for entry in resident)
            return {
                "hits": int(self._hits),
                "misses": int(self._misses),
                "evictions": int(self._evictions),
                "resident_videos": len(resident),
                "peak_resident_videos": int(self._peak_resident_videos),
                "estimated_resident_bytes": int(estimated_bytes),
                "resident_estimated_bytes": int(estimated_bytes),
                "peak_estimated_bytes": int(self._peak_estimated_bytes),
                "capacity": int(self.max_resident_videos),
                "byte_capacity": int(self.max_resident_bytes or 0),
                "oversized_pair_or_resource": int(self._oversized_pair_or_resource),
            }
