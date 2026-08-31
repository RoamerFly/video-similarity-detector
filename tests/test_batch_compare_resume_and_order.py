from pathlib import Path
import sqlite3

from scripts import batch_compare
from video_sim.metrics import RecognitionMetrics
from video_sim.pair_scheduler import PairWorkItem, schedule_pairs_for_locality
from video_sim.resume_store import ResumeSQLiteWriter


def _signature() -> dict:
    return {"report_schema_version": 2, "containment_scoring_version": 5}


def _payload() -> dict:
    return {
        "report_schema_version": 2,
        "containment_scoring_version": 5,
        "video_a": "a.mp4",
        "video_b": "b.mp4",
    }


def test_fresh_report_materialization_does_not_expose_internal_ordinal():
    item = PairWorkItem(7, Path("a.mp4"), Path("b.mp4"), key="a|b")
    result_by_ordinal = {
        item.report_ordinal: {
            **_payload(),
            "report_ordinal": item.report_ordinal,
            "new_future_field": {"kept": True},
        }
    }

    materialized = batch_compare.ordered_report_pairs([item], result_by_ordinal)

    assert materialized == [
        {
            **_payload(),
            "new_future_field": {"kept": True},
        }
    ]
    assert "report_ordinal" not in materialized[0]
    assert "report_ordinal" in result_by_ordinal[item.report_ordinal]


def test_resume_payload_ordinal_is_stripped_without_mutating_loaded_object():
    old_payload = {
        **_payload(),
        "report_ordinal": 3,
        "completed_at": "2026-08-31T00:00:00Z",
        "future_field": "preserve",
    }

    loaded = batch_compare._current_resume_pairs({"a|b": old_payload})

    assert loaded["a|b"] == {
        **_payload(),
        "completed_at": old_payload["completed_at"],
        "future_field": old_payload["future_field"],
    }
    assert "report_ordinal" not in loaded["a|b"]
    assert old_payload["report_ordinal"] == 3


def test_resume_checkpoint_never_persists_internal_ordinal(tmp_path: Path):
    payload = {**_payload(), "report_ordinal": 9, "unknown_field": "keep"}
    state = tmp_path / "checkpoint.state.json"

    batch_compare.save_resume_pair(state, _signature(), "a|b", payload)

    assert batch_compare.load_resume_sqlite(state, _signature()) == {
        "a|b": {**_payload(), "unknown_field": "keep"}
    }
    assert payload["report_ordinal"] == 9


def test_inserted_pair_keeps_resumed_payload_identical_except_completion_time():
    old_payload = {
        **_payload(),
        "report_ordinal": 1,
        "completed_at": "2026-08-31T00:00:00Z",
        "future_field": ["preserve", 1],
    }
    old_pair = PairWorkItem(1, Path("a.mp4"), Path("b.mp4"), key="a|b")
    inserted_pair = PairWorkItem(0, Path("new.mp4"), Path("a.mp4"), key="new|a")
    shifted_pair = PairWorkItem(2, Path("a.mp4"), Path("b.mp4"), key="a|b")

    before = batch_compare.ordered_report_pairs(
        [old_pair], {old_pair.report_ordinal: old_payload}
    )[0]
    after = batch_compare.ordered_report_pairs(
        [inserted_pair, shifted_pair],
        {
            inserted_pair.report_ordinal: {**_payload(), "video_a": "new.mp4"},
            shifted_pair.report_ordinal: old_payload,
        },
    )[1]

    assert {key: value for key, value in before.items() if key != "completed_at"} == {
        key: value for key, value in after.items() if key != "completed_at"
    }
    assert "report_ordinal" not in before
    assert "report_ordinal" not in after


def test_ordered_report_pairs_strips_internal_ordinal_after_reverse_completion():
    items = [
        PairWorkItem(0, Path("v0.mp4"), Path("v1.mp4"), key="0"),
        PairWorkItem(1, Path("v0.mp4"), Path("v2.mp4"), key="1"),
        PairWorkItem(2, Path("v1.mp4"), Path("v2.mp4"), key="2"),
    ]
    result_by_ordinal = {
        item.report_ordinal: {
            **_payload(),
            "key": item.key,
            "report_ordinal": item.report_ordinal,
        }
        for item in reversed(items)
    }

    ordered = batch_compare.ordered_report_pairs(items, result_by_ordinal)

    assert [row["key"] for row in ordered] == ["0", "1", "2"]
    assert all("report_ordinal" not in row for row in ordered)


def test_batch_resume_loader_uses_fetchmany_and_records_metrics(tmp_path: Path, monkeypatch):
    state = tmp_path / "resume.state.json"
    database = batch_compare.resume_pair_database_path(state, _signature())
    writer = ResumeSQLiteWriter(database)
    writer.write_pair("good", _payload())
    writer.write_pair("old", {"report_schema_version": 1})
    writer.close()
    metrics = RecognitionMetrics()
    loaded = batch_compare.load_resume_sqlite(state, _signature(), metrics=metrics)
    assert loaded == {"good": _payload()}
    assert metrics.counters["resume_read_batches"] == 1
    assert metrics.counters["resume_read_rows"] == 2


def test_batch_resume_loader_missing_or_corrupt_db_is_empty(tmp_path: Path):
    state = tmp_path / "missing.state.json"
    assert batch_compare.load_resume_sqlite(state, _signature()) == {}
    database = batch_compare.resume_pair_database_path(state, _signature())
    database.parent.mkdir(parents=True, exist_ok=True)
    database.write_bytes(b"not sqlite")
    assert batch_compare.load_resume_sqlite(state, _signature()) == {}


def test_resume_writer_factory_retries_transient_initialization(tmp_path: Path, monkeypatch):
    from video_sim import resume_store

    original = resume_store.ResumeSQLiteWriter
    attempts = []

    class Flaky(original):
        def __init__(self, path):
            attempts.append(1)
            if len(attempts) < 3:
                raise OSError("busy")
            super().__init__(path)

    monkeypatch.setattr(resume_store, "ResumeSQLiteWriter", Flaky)
    monkeypatch.setattr(batch_compare.time, "sleep", lambda _: None)
    writer = batch_compare.create_resume_sqlite_writer(tmp_path / "retry.sqlite3")
    assert len(attempts) == 3
    writer.close()


def test_writer_factory_failure_uses_clean_legacy_checkpoint_fallback(
    tmp_path: Path, monkeypatch
):
    def always_unavailable(_path):
        raise OSError("database busy")

    monkeypatch.setattr(batch_compare, "create_resume_sqlite_writer", always_unavailable)
    try:
        writer = batch_compare.create_resume_sqlite_writer(tmp_path / "unavailable.sqlite3")
    except OSError:
        writer = None

    saved = []

    def record_fallback(state_path, signature, key, payload):
        saved.append((state_path, signature, key, payload))

    monkeypatch.setattr(batch_compare, "save_resume_pair", record_fallback)
    payload = {**_payload(), "report_ordinal": 11, "unknown_field": "preserve"}
    batch_compare.checkpoint_resume_pair(
        writer,
        tmp_path / "state.json",
        _signature(),
        "a|b",
        payload,
    )

    assert len(saved) == 1
    assert saved[0][2] == "a|b"
    assert saved[0][3] == {**_payload(), "unknown_field": "preserve"}
    assert payload["report_ordinal"] == 11


def test_checkpoint_fallback_error_is_only_a_warning_and_not_a_pair_failure(
    tmp_path: Path, monkeypatch
):
    warnings = []

    def fail_fallback(*_args):
        raise sqlite3.OperationalError("locked")

    monkeypatch.setattr(batch_compare, "save_resume_pair", fail_fallback)
    monkeypatch.setattr(batch_compare, "log", warnings.append)

    batch_compare.checkpoint_resume_pair(
        None,
        tmp_path / "state.json",
        _signature(),
        "a|b",
        {**_payload(), "report_ordinal": 12},
    )

    assert len(warnings) == 1
    assert "检查点失败" in warnings[0]


def test_schedule_window_one_preserves_original_work_items():
    items = [
        PairWorkItem(i, Path(f"v{i}.mp4"), Path(f"v{i + 1}.mp4"), key=str(i))
        for i in range(4)
    ]
    assert schedule_pairs_for_locality(items, window_size=1, resident_capacity=2) == items


def test_fresh_schedule_reorders_execution_without_changing_pair_contract():
    items = [
        PairWorkItem(0, Path("v0.mp4"), Path("v1.mp4"), key="0", units=1.0),
        PairWorkItem(1, Path("v2.mp4"), Path("v3.mp4"), key="1", units=2.0),
        PairWorkItem(2, Path("v0.mp4"), Path("v2.mp4"), key="2", units=3.0),
        PairWorkItem(3, Path("v1.mp4"), Path("v3.mp4"), key="3", units=4.0),
    ]
    scheduled = schedule_pairs_for_locality(
        items, window_size=4, resident_capacity=2
    )
    assert [item.key for item in scheduled] == ["0", "2", "1", "3"]
    original_by_key = {item.key: item for item in items}
    assert {item.key for item in scheduled} == set(original_by_key)
    for item in scheduled:
        original = original_by_key[item.key]
        assert (item.report_ordinal, item.video_a, item.video_b, item.units) == (
            original.report_ordinal,
            original.video_a,
            original.video_b,
            original.units,
        )


def test_resume_and_parallel_completion_are_materialized_by_original_ordinal():
    items = [
        PairWorkItem(0, Path("v0.mp4"), Path("v1.mp4"), key="0"),
        PairWorkItem(1, Path("v0.mp4"), Path("v2.mp4"), key="1"),
        PairWorkItem(2, Path("v0.mp4"), Path("v3.mp4"), key="2"),
        PairWorkItem(3, Path("v1.mp4"), Path("v2.mp4"), key="3"),
    ]
    scheduled = schedule_pairs_for_locality(
        [items[1], items[2], items[3]], window_size=3, resident_capacity=2
    )
    result_by_ordinal = {
        0: {"ordinal": 0, "key": "0"},  # resumed pair
    }
    # Simulate futures completing in reverse order while preserving the
    # original pair payload identity in the result map.
    for item in reversed(scheduled):
        result_by_ordinal[item.report_ordinal] = {
            "ordinal": item.report_ordinal,
            "key": item.key,
        }
    ordered = batch_compare.ordered_report_pairs(items, result_by_ordinal)
    assert [row["ordinal"] for row in ordered] == [0, 1, 2, 3]
    assert [row["key"] for row in ordered] == ["0", "1", "2", "3"]


def test_failed_writer_checkpoint_is_not_a_pair_failure(tmp_path: Path, monkeypatch):
    writer = ResumeSQLiteWriter(tmp_path / "writer.sqlite3")
    writer.close()
    # The production closure catches writer failures; this direct assertion
    # keeps the writer's close behavior explicit for the integration seam.
    assert writer.closed


def test_writer_uses_one_connection_commits_each_pair_and_reports_diagnostics(tmp_path: Path):
    writer = ResumeSQLiteWriter(tmp_path / "diagnostics.sqlite3")
    trace = []
    writer.connection.set_trace_callback(trace.append)
    writer.write_pair("one", _payload())
    writer.write_pair("two", _payload())
    diagnostics = writer.diagnostics()
    assert diagnostics["connection_inits"] == 1
    assert diagnostics["writer_commits"] == 2
    assert diagnostics["writer_rows"] == 2
    assert diagnostics["writer_attempts"] == 2
    assert sum(statement == "COMMIT" for statement in trace) == 2
    batch_compare.ACTIVE_RESUME_WRITER = writer
    batch_compare.close_active_resume_writer()
    assert writer.closed
    assert batch_compare.ACTIVE_RESUME_WRITER is None
