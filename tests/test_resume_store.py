from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import threading

import pytest

from video_sim.resume_store import (
    ResumeReadDiagnostics,
    ResumeSQLiteWriter,
    load_resume_pairs,
    load_resume_pairs_fetchmany,
)


def test_writer_initializes_once_and_commits_each_pair(tmp_path: Path) -> None:
    database_path = tmp_path / "resume.sqlite3"
    writer = ResumeSQLiteWriter(database_path)
    writer.write_pair("first", {"value": 1})
    writer.write_pair("second", {"value": 2})
    assert writer.diagnostics() == {
        "writer_commits": 2,
        "writer_rows": 2,
        "writer_attempts": 2,
        "writer_retries": 0,
        "connection_inits": 1,
    }
    writer.close()

    with sqlite3.connect(database_path) as connection:
        rows = connection.execute(
            "SELECT pair_key, pair_json FROM completed_pairs ORDER BY pair_key"
        ).fetchall()
    assert rows == [
        ("first", '{"value":1}'),
        ("second", '{"value":2}'),
    ]


def test_writer_upsert_preserves_latest_payload(tmp_path: Path) -> None:
    writer = ResumeSQLiteWriter(tmp_path / "resume.sqlite3")
    writer.write_pair("same", {"version": 1})
    writer.write_pair("same", {"version": 2, "legacy": True})
    writer.close()

    loaded = load_resume_pairs(tmp_path / "resume.sqlite3")
    assert loaded == {"same": {"version": 2, "legacy": True}}
    assert loaded.diagnostics == {"read_batches": 1, "read_rows": 1}


def test_failed_payload_rolls_back_and_connection_remains_usable(tmp_path: Path) -> None:
    writer = ResumeSQLiteWriter(tmp_path / "resume.sqlite3")
    with pytest.raises(TypeError):
        writer.write_pair("broken", {"value": object()})
    writer.write_pair("after-failure", {"value": 3})
    assert writer.stats()["writer_commits"] == 1
    writer.close()

    assert load_resume_pairs(tmp_path / "resume.sqlite3") == {
        "after-failure": {"value": 3}
    }


@pytest.mark.parametrize("failure_point", ["execute", "commit"])
def test_transient_sqlite_failure_retries_same_connection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_point: str,
) -> None:
    database_path = tmp_path / f"retry-{failure_point}.sqlite3"
    original_connect = sqlite3.connect
    sleep_delays: list[float] = []

    class FlakyConnection:
        def __init__(self, connection: sqlite3.Connection) -> None:
            self._connection = connection
            self._failed = False
            self._initialized = False
            self._init_commit_seen = False

        def execute(self, sql: str, parameters=()):
            if failure_point == "execute" and sql.startswith("INSERT") and not self._failed:
                self._failed = True
                raise sqlite3.OperationalError("database is locked")
            result = self._connection.execute(sql, parameters)
            if sql.startswith("CREATE TABLE"):
                self._initialized = True
            return result

        def commit(self):
            if failure_point == "commit" and self._initialized and not self._failed:
                if self._init_commit_seen:
                    self._failed = True
                    raise sqlite3.OperationalError("database is busy")
                self._init_commit_seen = True
            return self._connection.commit()

        def rollback(self):
            return self._connection.rollback()

        def close(self):
            return self._connection.close()

    connections: list[FlakyConnection] = []

    def connect(*args, **kwargs):
        proxy = FlakyConnection(original_connect(*args, **kwargs))
        connections.append(proxy)
        return proxy

    monkeypatch.setattr("video_sim.resume_store.sqlite3.connect", connect)
    writer = ResumeSQLiteWriter(
        database_path,
        max_attempts=3,
        retry_delay=0.25,
        sleep_fn=sleep_delays.append,
    )
    writer.write_pair("one", {"value": 1})
    assert writer.diagnostics() == {
        "writer_commits": 1,
        "writer_rows": 1,
        "writer_attempts": 2,
        "writer_retries": 1,
        "connection_inits": 1,
    }
    assert sleep_delays == [0.25]
    assert len(connections) == 1
    writer.close()

    assert load_resume_pairs(database_path) == {"one": {"value": 1}}


def test_writer_context_closes_and_close_is_idempotent(tmp_path: Path) -> None:
    database_path = tmp_path / "resume.sqlite3"
    with ResumeSQLiteWriter(database_path) as writer:
        writer.write_pair("one", {"ok": True})
    assert writer.closed
    writer.close()
    with pytest.raises(RuntimeError, match="closed"):
        writer.write_pair("two", {})


def test_writer_rejects_cross_thread_use(tmp_path: Path) -> None:
    writer = ResumeSQLiteWriter(tmp_path / "resume.sqlite3")
    errors: list[BaseException] = []

    def misuse() -> None:
        try:
            writer.write_pair("wrong-thread", {})
        except BaseException as exc:  # pragma: no branch - assertion below
            errors.append(exc)

    thread = threading.Thread(target=misuse)
    thread.start()
    thread.join()
    writer.close()
    assert len(errors) == 1
    assert isinstance(errors[0], RuntimeError)


def test_writer_reads_existing_legacy_schema_and_payload(tmp_path: Path) -> None:
    database_path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "CREATE TABLE completed_pairs ("
            "pair_key TEXT PRIMARY KEY, pair_json TEXT NOT NULL"
            ")"
        )
        connection.execute(
            "INSERT INTO completed_pairs(pair_key, pair_json) VALUES (?, ?)",
            ("old-key", json.dumps({"legacy": "payload", "n": 4})),
        )
    writer = ResumeSQLiteWriter(database_path)
    writer.write_pair("new-key", {"modern": True})
    writer.close()

    assert load_resume_pairs(database_path) == {
        "old-key": {"legacy": "payload", "n": 4},
        "new-key": {"modern": True},
    }


def test_fetchmany_batches_rows_without_fetchall(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    database_path = tmp_path / "resume.sqlite3"
    writer = ResumeSQLiteWriter(database_path)
    writer.write_pairs((f"key-{i}", {"i": i}) for i in range(5))
    writer.close()

    original_connect = sqlite3.connect

    class CursorProxy:
        def __init__(self, cursor):
            self._cursor = cursor

        def fetchall(self):
            raise AssertionError("fetchall must not be used")

        def fetchmany(self, size):
            return self._cursor.fetchmany(size)

    class ConnectionProxy:
        def __init__(self, connection):
            self._connection = connection

        def execute(self, sql, parameters=()):
            return CursorProxy(self._connection.execute(sql, parameters))

        def close(self):
            return self._connection.close()

    def connect(*args, **kwargs):
        return ConnectionProxy(original_connect(*args, **kwargs))

    monkeypatch.setattr("video_sim.resume_store.sqlite3.connect", connect)
    diagnostics: dict[str, int] = {}
    loaded = load_resume_pairs_fetchmany(
        database_path,
        batch_size=2,
        diagnostics=diagnostics,
    )
    assert loaded == {f"key-{i}": {"i": i} for i in range(5)}
    assert loaded.diagnostics == {"read_batches": 3, "read_rows": 5}
    assert diagnostics == {"read_batches": 3, "read_rows": 5}


def test_read_diagnostics_object_and_default_batch_size(tmp_path: Path) -> None:
    database_path = tmp_path / "resume.sqlite3"
    writer = ResumeSQLiteWriter(database_path)
    writer.write_pairs((f"key-{i}", {"i": i}) for i in range(513))
    writer.close()

    diagnostics = ResumeReadDiagnostics()
    loaded = load_resume_pairs(database_path, diagnostics=diagnostics)
    assert len(loaded) == 513
    assert diagnostics.read_batches == 2
    assert diagnostics.read_rows == 513


def test_invalid_batch_size_is_rejected(tmp_path: Path) -> None:
    with pytest.raises((TypeError, ValueError)):
        load_resume_pairs(tmp_path / "missing.sqlite3", batch_size=0)
