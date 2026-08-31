from concurrent.futures import ThreadPoolExecutor
import threading
import weakref

from scripts import batch_compare


def test_exact_pool_faiss_initializer_runs_once_on_each_worker(monkeypatch):
    calls = []

    def fake_configure(*, compare_workers):
        calls.append((threading.get_ident(), compare_workers))
        return 1

    monkeypatch.setattr(
        "video_sim.indexer.configure_faiss_thread_budget",
        fake_configure,
    )
    worker_count = 3
    barrier = threading.Barrier(worker_count)

    def query_work():
        barrier.wait(timeout=5)
        return threading.get_ident()

    with ThreadPoolExecutor(
        max_workers=worker_count,
        initializer=batch_compare.faiss_thread_budget_initializer,
        initargs=(worker_count,),
    ) as executor:
        worker_ids = [executor.submit(query_work) for _ in range(worker_count)]
        completed_ids = {future.result(timeout=5) for future in worker_ids}

    configured_ids = {thread_id for thread_id, _ in calls}
    assert completed_ids == configured_ids
    assert len(configured_ids) == worker_count
    assert [workers for _, workers in calls] == [worker_count] * worker_count


class _FakeCuda:
    def __init__(self, available):
        self.available = available
        self.empty_cache_calls = 0

    def is_available(self):
        return self.available

    def empty_cache(self):
        self.empty_cache_calls += 1


class _FakeTorch:
    def __init__(self, available):
        self.cuda = _FakeCuda(available)


def test_release_embedder_reference_is_safe_for_cpu_and_cuda():
    cpu_torch = _FakeTorch(available=True)
    cpu_status = batch_compare.release_embedder_reference(
        True, "cpu", torch_module=cpu_torch
    )
    assert cpu_status["had_embedder"] is True
    assert cpu_status["cuda_cache_cleared"] is False
    assert cpu_torch.cuda.empty_cache_calls == 0

    class Marker:
        pass

    marker = Marker()
    marker_ref = weakref.ref(marker)
    cuda_torch = _FakeTorch(available=True)
    cuda_torch.cuda.before_empty_cache = marker_ref
    original_empty_cache = cuda_torch.cuda.empty_cache

    def check_reference_before_empty_cache():
        assert cuda_torch.cuda.before_empty_cache() is None
        original_empty_cache()

    cuda_torch.cuda.empty_cache = check_reference_before_empty_cache
    had_marker = marker is not None
    marker = None
    cuda_status = batch_compare.release_embedder_reference(
        had_marker, "cuda", torch_module=cuda_torch
    )
    assert cuda_status["had_embedder"] is True
    assert cuda_status["cuda_cache_cleared"] is True
    assert cuda_torch.cuda.empty_cache_calls == 1


def test_release_embedder_reference_does_not_require_torch_for_cpu():
    status = batch_compare.release_embedder_reference(False, "cpu")

    assert status["had_embedder"] is False
    assert status["cuda_cache_cleared"] is False
