from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
import time

import numpy as np

from video_sim.embedder import FrameEmbeddingCache
from video_sim.indexer import build_frame_index
from video_sim.resource_pool import ExactResourcePool


def _cache(path: Path) -> FrameEmbeddingCache:
    values = np.eye(4, dtype="float32")
    return FrameEmbeddingCache(
        video_path=str(path),
        frame_indices=np.arange(4, dtype=np.int64),
        timestamps=np.arange(4, dtype="float32"),
        phashes=["p0"] * 4,
        thumbnail_paths=[],
        embeddings=values,
    )


def test_pool_lru_eviction_and_stats(tmp_path: Path):
    caches = {tmp_path / f"{name}.npz": _cache(tmp_path / f"{name}.mp4") for name in "abc"}
    pool = ExactResourcePool(
        max_resident_videos=2,
        cache_loader=lambda path: caches[path],
    )
    with pool.acquire_pair(next(iter(caches)), list(caches)[1]):
        pass
    with pool.acquire(list(caches)[2]):
        pass
    stats = pool.stats()
    assert stats["peak_resident_videos"] == 2
    assert stats["evictions"] >= 1
    assert stats["resident_videos"] == 2


def test_pool_pair_keeps_shared_resource_when_loading_other_side(tmp_path: Path):
    paths = [tmp_path / f"{name}.npz" for name in "abc"]
    caches = {path: _cache(path.with_suffix(".mp4")) for path in paths}
    pool = ExactResourcePool(
        max_resident_videos=2,
        cache_loader=lambda path: caches[path],
    )

    with pool.acquire_pair(paths[0], paths[1]) as (first_left, first_right):
        assert first_left.cache is caches[paths[0]]
        assert first_right.cache is caches[paths[1]]
    with pool.acquire_pair(paths[0], paths[2]) as (second_left, second_right):
        assert second_left.cache is caches[paths[0]]
        assert second_right.cache is caches[paths[2]]

    stats = pool.stats()
    assert stats["misses"] == 3
    assert stats["evictions"] == 1


def test_pool_concurrent_same_item_loads_once(tmp_path: Path):
    path = tmp_path / "one.npz"
    cache = _cache(tmp_path / "one.mp4")
    calls = 0
    lock = threading.Lock()

    def loader(_path):
        nonlocal calls
        with lock:
            calls += 1
        time.sleep(0.03)
        return cache

    pool = ExactResourcePool(max_resident_videos=2, cache_loader=loader)

    def use_resource():
        with pool.acquire(path) as resource:
            return resource.cache is cache

    with ThreadPoolExecutor(max_workers=4) as executor:
        assert all(executor.map(lambda _item: use_resource(), range(4)))
    assert calls == 1
    assert pool.stats()["hits"] >= 3


def test_pool_pair_reservation_avoids_cross_pair_deadlock(tmp_path: Path):
    paths = [tmp_path / f"{name}.npz" for name in "abcd"]
    caches = {path: _cache(path.with_suffix(".mp4")) for path in paths}
    pool = ExactResourcePool(
        max_resident_videos=2,
        cache_loader=lambda path: caches[path],
    )

    def use_pair(left, right):
        with pool.acquire_pair(left, right):
            time.sleep(0.02)
        return True

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(use_pair, paths[0], paths[2])
        second = executor.submit(use_pair, paths[1], paths[3])
        assert first.result(timeout=2.0)
        assert second.result(timeout=2.0)


def test_pool_releases_after_loader_or_lease_exception(tmp_path: Path):
    good_path = tmp_path / "good.npz"
    bad_path = tmp_path / "bad.npz"
    cache = _cache(tmp_path / "good.mp4")

    def loader(path):
        if path == bad_path:
            raise ValueError("broken cache")
        return cache

    pool = ExactResourcePool(max_resident_videos=2, cache_loader=loader)
    try:
        with pool.acquire(bad_path):
            pass
    except ValueError:
        pass
    with pool.acquire(good_path):
        raise_error = True
        try:
            raise RuntimeError("cancel")
        except RuntimeError:
            pass
    assert pool.stats()["resident_videos"] == 1
    assert raise_error
