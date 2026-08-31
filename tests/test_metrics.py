import json

import video_sim.metrics as metrics_module
from video_sim.metrics import RecognitionMetrics
from video_sim.reporter import BatchReportData


def test_metrics_record_and_round_trip(tmp_path):
    metrics = RecognitionMetrics()
    metrics.record_stage("candidate", 0.0123, items=4)
    metrics.count("embeddings", 8)

    encoded = metrics.to_dict()
    assert encoded["stages"]["candidate"]["calls"] == 1
    assert encoded["stages"]["candidate"]["items"] == 4
    assert encoded["counters"]["embeddings"] == 8

    path = metrics.save_json(tmp_path / "metrics.json")
    loaded = RecognitionMetrics.from_dict(json.loads(path.read_text(encoding="utf-8")))
    assert loaded.to_dict()["stages"]["candidate"]["calls"] == 1


def test_metrics_batch_matches_individual_stage_records_and_snapshots_once(monkeypatch):
    batch = RecognitionMetrics()
    individual = RecognitionMetrics()
    batch_snapshots = []
    individual_snapshots = []
    monkeypatch.setattr(batch, "snapshot_resources", lambda: batch_snapshots.append(1))
    monkeypatch.setattr(individual, "snapshot_resources", lambda: individual_snapshots.append(1))

    records = [
        ("dynamic_stage", 0.0125, 2),
        ("dynamic_stage", 0.5, 3),
        ("another_stage", 0.0, 0),
    ]
    batch.add_elapsed_batch(records)
    for name, elapsed, items in records:
        individual.record_stage(name, elapsed, items=items)

    for name in ("dynamic_stage", "another_stage"):
        assert batch.stages[name].elapsed_ms == individual.stages[name].elapsed_ms
        assert batch.stages[name].calls == individual.stages[name].calls
        assert batch.stages[name].items == individual.stages[name].items
    assert batch_snapshots == [1]
    assert len(individual_snapshots) == len(records)


def test_metrics_batch_clamps_negative_values_and_empty_batch_is_noop(monkeypatch):
    metrics = RecognitionMetrics()
    snapshots = []
    monkeypatch.setattr(metrics, "snapshot_resources", lambda: snapshots.append(1))

    metrics.add_elapsed_batch([])
    assert snapshots == []

    metrics.add_elapsed_batch(
        [("dynamic_stage", -4.0, -7), ("zero_stage", 0.0, 0)]
    )
    assert snapshots == [1]
    assert metrics.stages["dynamic_stage"].elapsed_ms == 0.0
    assert metrics.stages["dynamic_stage"].items == 0
    assert metrics.stages["dynamic_stage"].calls == 1
    assert metrics.stages["zero_stage"].calls == 1


def test_metrics_accepts_legacy_or_partial_payloads():
    loaded = RecognitionMetrics.from_dict({"stages": {"embed": {"elapsed_ms": 2}}})
    payload = loaded.to_dict()
    assert payload["stages"]["embed"]["elapsed_ms"] == 2.0
    assert payload["stages"]["embed"]["aggregation"] == "accumulated"
    assert payload["stages"]["decode_sample"]["calls"] == 0


def test_report_payload_keeps_metrics_optional_for_old_consumers():
    report = BatchReportData(timestamp="now")
    assert "metrics" not in report.to_dict()
    report.metrics = {"schema_version": 1}
    assert report.to_dict()["metrics"]["schema_version"] == 1


def test_metrics_report_baseline_peak_and_delta(monkeypatch):
    snapshots = iter(
        [
            {"current_rss_bytes": 100, "peak_rss_bytes": 100},
            {"current_rss_bytes": 120, "peak_rss_bytes": 175},
            {"current_rss_bytes": 120, "peak_rss_bytes": 175},
        ]
    )
    monkeypatch.setattr(metrics_module, "process_memory_snapshot", lambda: next(snapshots))
    monkeypatch.setattr(metrics_module, "cuda_memory_snapshot", lambda: {})

    metrics = RecognitionMetrics()
    metrics.snapshot_resources()
    payload = metrics.to_dict()

    assert payload["baseline_rss_bytes"] == 100
    assert payload["current_rss_bytes"] == 120
    assert payload["observed_peak_rss_bytes"] == 175
    assert payload["peak_rss_delta_bytes"] == 75
    assert payload["peak_rss_bytes"] == 175  # backwards-compatible alias
    assert payload["wall_elapsed_ms"] is not None
    assert payload["stage_timing_aggregation"] == "accumulated_worker_time"


def test_memory_units_and_windows_peak_are_explicit(monkeypatch):
    assert metrics_module._resource_peak_rss_bytes(4096, "linux") == 4096 * 1024
    assert metrics_module._resource_peak_rss_bytes(4096, "darwin") == 4096

    monkeypatch.setattr(
        metrics_module,
        "_psutil_memory_snapshot",
        lambda _platform: {"current_rss_bytes": 100},
    )
    monkeypatch.setattr(
        metrics_module,
        "_windows_memory_snapshot",
        lambda: {"current_rss_bytes": 120, "peak_rss_bytes": 180},
    )
    assert metrics_module.process_memory_snapshot("nt") == {
        "current_rss_bytes": 100,
        "peak_rss_bytes": 180,
    }
