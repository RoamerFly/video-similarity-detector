from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
import time

import numpy as np
import pytest

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
    assert pool.stats()["successful_loads"] == 1
    assert pool.stats()["failed_loads"] == 0


def test_pool_counts_actual_successful_and_failed_loads(tmp_path: Path):
    good_path = tmp_path / "a-good.npz"
    bad_path = tmp_path / "z-bad.npz"
    cache = _cache(good_path.with_suffix(".mp4"))

    def loader(path):
        if path == bad_path:
            raise ValueError("broken cache")
        return cache

    pool = ExactResourcePool(cache_loader=loader)
    with pool.acquire(good_path):
        pass
    with pytest.raises(ValueError, match="broken cache"):
        with pool.acquire(bad_path):
            pass

    stats = pool.stats()
    assert stats["successful_loads"] == 1
    assert stats["failed_loads"] == 1
    assert stats["misses"] == 2


def test_pool_counts_index_builder_failure_as_failed_load(tmp_path: Path):
    path = tmp_path / "index-fails.npz"
    cache = _cache(path.with_suffix(".mp4"))

    def bad_index(_cache_value):
        raise ValueError("bad index")

    pool = ExactResourcePool(
        cache_loader=lambda _path: cache,
        index_builder=bad_index,
    )

    with pytest.raises(ValueError, match="bad index"):
        with pool.acquire(path):
            pass

    stats = pool.stats()
    assert stats["successful_loads"] == 0
    assert stats["failed_loads"] == 1


def test_pool_pair_counts_each_actual_endpoint_load_and_failure(tmp_path: Path):
    good_path = tmp_path / "a-good.npz"
    bad_path = tmp_path / "z-bad.npz"
    cache = _cache(good_path.with_suffix(".mp4"))

    def loader(path):
        if path == bad_path:
            raise ValueError("broken pair cache")
        return cache

    pool = ExactResourcePool(cache_loader=loader)
    with pytest.raises(ValueError, match="broken pair cache"):
        with pool.acquire_pair(good_path, bad_path):
            pass

    stats = pool.stats()
    assert stats["successful_loads"] == 1
    assert stats["failed_loads"] == 1
    assert stats["resident_videos"] == 1


def test_pool_body_exception_is_not_counted_as_failed_load(tmp_path: Path):
    path = tmp_path / "one.npz"
    cache = _cache(path.with_suffix(".mp4"))
    pool = ExactResourcePool(cache_loader=lambda _path: cache)

    with pytest.raises(RuntimeError, match="body failure"):
        with pool.acquire(path):
            raise RuntimeError("body failure")

    assert pool.stats()["successful_loads"] == 1
    assert pool.stats()["failed_loads"] == 0


def test_pool_pair_body_exception_is_not_counted_as_failed_load(tmp_path: Path):
    paths = [tmp_path / f"{name}.npz" for name in "ab"]
    caches = {path: _cache(path.with_suffix(".mp4")) for path in paths}
    pool = ExactResourcePool(
        max_resident_videos=2,
        cache_loader=lambda path: caches[path],
    )

    with pytest.raises(RuntimeError, match="pair body failure"):
        with pool.acquire_pair(paths[0], paths[1]):
            raise RuntimeError("pair body failure")

    stats = pool.stats()
    assert stats["successful_loads"] == 2
    assert stats["failed_loads"] == 0


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


def _estimated_cache_bytes(
    path: Path,
    cache_loader,
) -> int:
    """Read the pool's estimate once so byte-budget tests stay shape agnostic."""

    probe = ExactResourcePool(max_resident_videos=2, cache_loader=cache_loader)
    with probe.acquire(path):
        return int(probe.stats()["estimated_resident_bytes"])


def test_pool_byte_budget_evicts_lru_after_loaded_resource_is_measured(tmp_path: Path):
    paths = [tmp_path / f"{name}.npz" for name in "ab"]
    caches = {path: _cache(path.with_suffix(".mp4")) for path in paths}
    loader = lambda path: caches[path]
    estimated = {
        path: _estimated_cache_bytes(path, loader) for path in paths
    }
    byte_capacity = max(estimated.values()) + 1
    pool = ExactResourcePool(
        max_resident_videos=2,
        max_resident_bytes=byte_capacity,
        cache_loader=loader,
    )

    with pool.acquire(paths[0]):
        pass
    with pool.acquire(paths[1]):
        stats = pool.stats()
        assert stats["resident_videos"] == 1
        assert stats["estimated_resident_bytes"] <= byte_capacity

    stats = pool.stats()
    assert stats["evictions"] >= 1
    assert stats["peak_estimated_bytes"] >= max(estimated.values())
    assert stats["byte_capacity"] == byte_capacity


def test_pool_allows_single_oversized_resource_without_waiting_forever(tmp_path: Path):
    paths = [tmp_path / f"{name}.npz" for name in "ab"]
    caches = {path: _cache(path.with_suffix(".mp4")) for path in paths}
    loader = lambda path: caches[path]
    estimated = _estimated_cache_bytes(paths[0], loader)
    pool = ExactResourcePool(
        max_resident_videos=2,
        max_resident_bytes=max(1, estimated // 2),
        cache_loader=loader,
    )

    with pool.acquire(paths[0]):
        stats = pool.stats()
        assert stats["resident_videos"] == 1
        assert stats["estimated_resident_bytes"] > stats["byte_capacity"]

    # The first oversized resource is released, so the next load must be
    # admitted instead of waiting for a byte budget that it cannot satisfy.
    with pool.acquire(paths[1]):
        assert pool.stats()["resident_videos"] == 1
    assert pool.stats()["oversized_pair_or_resource"] == 2


def test_pool_pair_soft_overage_is_counted_once_and_both_sides_are_available(
    tmp_path: Path,
):
    paths = [tmp_path / f"{name}.npz" for name in "ab"]
    caches = {path: _cache(path.with_suffix(".mp4")) for path in paths}
    loader = lambda path: caches[path]
    estimated = {
        path: _estimated_cache_bytes(path, loader) for path in paths
    }
    byte_capacity = sum(estimated.values()) - 1
    pool = ExactResourcePool(
        max_resident_videos=2,
        max_resident_bytes=byte_capacity,
        cache_loader=loader,
    )

    with pool.acquire_pair(paths[0], paths[1]) as (left, right):
        assert left.cache is caches[paths[0]]
        assert right.cache is caches[paths[1]]
        stats = pool.stats()
        assert stats["resident_videos"] == 2
        assert stats["estimated_resident_bytes"] > byte_capacity
        assert stats["oversized_pair_or_resource"] == 1


def test_pool_byte_budget_can_be_enabled_from_environment(tmp_path: Path, monkeypatch):
    path = tmp_path / "one.npz"
    cache = _cache(tmp_path / "one.mp4")
    loader = lambda _path: cache
    estimated = _estimated_cache_bytes(path, loader)
    monkeypatch.setenv("VIDEO_SIM_EXACT_CACHE_BYTES", str(estimated))
    pool = ExactResourcePool(max_resident_videos=2, cache_loader=loader)

    with pool.acquire(path):
        assert pool.stats()["byte_capacity"] == estimated


def test_pool_estimate_counts_index_thumbnail_list_copy(tmp_path: Path):
    path = tmp_path / "one.npz"
    cache = _cache(tmp_path / "one.mp4")
    cache.thumbnail_paths = ["thumbnail-" + ("x" * 64)]
    pool = ExactResourcePool(cache_loader=lambda _path: cache)

    with pool.acquire(path):
        estimated = pool.stats()["estimated_resident_bytes"]

    cache_without_thumbnails = _cache(tmp_path / "two.mp4")
    other_path = tmp_path / "two.npz"
    pool_without_thumbnails = ExactResourcePool(
        cache_loader=lambda _path: cache_without_thumbnails,
    )
    with pool_without_thumbnails.acquire(other_path):
        baseline = pool_without_thumbnails.stats()["estimated_resident_bytes"]

    # Both the cache list and build_frame_index's copied list are resident.
    assert estimated >= baseline + 2 * (len(cache.thumbnail_paths[0]) + 64)


def _run_pool_contenders_with_watchdog(pool, contenders):
    """Run contention tests without letting a regression hang the test run."""

    finished = threading.Event()
    timed_out = threading.Event()

    def release_byte_waiters_if_stuck():
        if finished.wait(1.5):
            return
        timed_out.set()
        # A failing implementation may leave workers waiting on the byte
        # condition forever.  Disable only the test pool's optional budget so
        # the executor can unwind and the assertion below reports the defect.
        with pool._condition:
            pool.max_resident_bytes = None
            pool._condition.notify_all()

    watchdog = threading.Thread(target=release_byte_waiters_if_stuck, daemon=True)
    watchdog.start()
    executor = ThreadPoolExecutor(max_workers=len(contenders))
    futures = [executor.submit(contender) for contender in contenders]
    try:
        results = [future.result(timeout=3.0) for future in futures]
    finally:
        finished.set()
        watchdog.join(timeout=1.0)
        executor.shutdown(wait=True, cancel_futures=True)
    assert not timed_out.is_set(), "resource pool contention did not complete"
    return results


def test_pool_byte_budget_concurrent_pairs_do_not_deadlock(tmp_path: Path):
    paths = [tmp_path / f"{name}.npz" for name in "abcd"]
    caches = {path: _cache(path.with_suffix(".mp4")) for path in paths}
    loader = lambda path: (time.sleep(0.01), caches[path])[1]
    estimated = {
        path: _estimated_cache_bytes(path, loader) for path in paths
    }
    byte_capacity = max(
        estimated[paths[0]] + estimated[paths[1]],
        estimated[paths[2]] + estimated[paths[3]],
    )
    pool = ExactResourcePool(
        max_resident_videos=4,
        max_resident_bytes=byte_capacity,
        cache_loader=loader,
    )
    start = threading.Barrier(2)

    def use_pair(left, right):
        start.wait()
        with pool.acquire_pair(left, right):
            time.sleep(0.03)
        return True

    results = _run_pool_contenders_with_watchdog(
        pool,
        [
            lambda: use_pair(paths[0], paths[1]),
            lambda: use_pair(paths[2], paths[3]),
        ],
    )
    assert results == [True, True]
    assert pool.stats()["estimated_resident_bytes"] <= byte_capacity


def test_pool_byte_budget_pair_and_single_resource_do_not_deadlock(tmp_path: Path):
    paths = [tmp_path / f"{name}.npz" for name in "abc"]
    caches = {path: _cache(path.with_suffix(".mp4")) for path in paths}
    loader = lambda path: (time.sleep(0.01), caches[path])[1]
    estimated = {
        path: _estimated_cache_bytes(path, loader) for path in paths
    }
    byte_capacity = estimated[paths[0]] + estimated[paths[1]]
    pool = ExactResourcePool(
        max_resident_videos=3,
        max_resident_bytes=byte_capacity,
        cache_loader=loader,
    )
    start = threading.Barrier(2)

    def use_pair():
        start.wait()
        with pool.acquire_pair(paths[0], paths[1]):
            time.sleep(0.03)
        return True

    def use_single():
        start.wait()
        with pool.acquire(paths[2]):
            time.sleep(0.03)
        return True

    results = _run_pool_contenders_with_watchdog(pool, [use_pair, use_single])
    assert results == [True, True]
    assert pool.stats()["estimated_resident_bytes"] <= byte_capacity
