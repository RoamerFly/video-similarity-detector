"""Bounded, thread-safe lifetime management for exact comparison resources."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import os
from pathlib import Path
from threading import Condition, Lock
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


class ExactResourcePool:
    """Load at most ``max_resident_videos`` exact resources at a time.

    A pair lease pins both cache/index entries for its whole comparison.  A
    cache requested concurrently by several workers is loaded once; later
    callers wait for that load and share the same object.  Only unpinned
    entries are eligible for LRU eviction.
    """

    def __init__(
        self,
        max_resident_videos: int | None = None,
        cache_loader: Callable[[Path], FrameEmbeddingCache] | None = None,
        index_builder: Callable[[FrameEmbeddingCache], FrameIndexResult] | None = None,
    ) -> None:
        configured = max_resident_videos
        if configured is None:
            raw = os.environ.get("VIDEO_SIM_EXACT_CACHE_VIDEOS", "").strip()
            configured = int(raw) if raw.isdigit() else 2
        self.max_resident_videos = max(2, int(configured or 2))
        self.cache_loader = cache_loader or FrameEmbeddingCache.load
        self.index_builder = index_builder or build_frame_index
        self._condition = Condition(Lock())
        self._entries: dict[str, _PoolEntry] = {}
        self._hits = 0
        self._misses = 0
        self._evictions = 0
        self._peak_resident_videos = 0

    @staticmethod
    def _key(path: str | Path) -> str:
        return str(Path(path).resolve(strict=False)).casefold()

    def _resident_count_locked(self) -> int:
        return sum(1 for entry in self._entries.values() if entry.resource is not None or entry.loading)

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
        except BaseException:
            with self._condition:
                self._entries.pop(key, None)
                self._condition.notify_all()
            raise
        with self._condition:
            entry = self._entries[key]
            entry.loading = False
            entry.resource = resource
            entry.refcount = 1
            entry.last_used = time.monotonic()
            self._peak_resident_videos = max(
                self._peak_resident_videos,
                self._resident_count_locked(),
            )
            self._condition.notify_all()
        return resource

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
            for key in new_keys:
                path = path_by_key[key]
                cache = self.cache_loader(path)
                resource = ExactResource(cache=cache, frame_index=self.index_builder(cache))
                with self._condition:
                    entry = self._entries[key]
                    entry.loading = False
                    entry.resource = resource
                    entry.refcount = 1
                    entry.last_used = time.monotonic()
                    self._peak_resident_videos = max(
                        self._peak_resident_videos,
                        self._resident_count_locked(),
                    )
                    self._condition.notify_all()
                resources_by_key[key] = resource
            for key in unique_keys:
                if key not in resources_by_key:
                    entry = self._entries[key]
                    if entry.resource is None:
                        raise RuntimeError(f"resource entry disappeared: {key}")
                    resources_by_key[key] = entry.resource
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
        with self._condition:
            resident = [entry for entry in self._entries.values() if entry.resource is not None]
            estimated_bytes = 0
            for entry in resident:
                resource = entry.resource
                if resource is None:
                    continue
                embeddings = np.asarray(resource.cache.embeddings)
                estimated_bytes += int(embeddings.nbytes)
                index = resource.frame_index.index
                dimension = int(getattr(index, "d", 0) or 0)
                estimated_bytes += int(index.ntotal) * dimension * 4
            return {
                "hits": int(self._hits),
                "misses": int(self._misses),
                "evictions": int(self._evictions),
                "resident_videos": len(resident),
                "peak_resident_videos": int(self._peak_resident_videos),
                "estimated_resident_bytes": int(estimated_bytes),
                "capacity": int(self.max_resident_videos),
            }
