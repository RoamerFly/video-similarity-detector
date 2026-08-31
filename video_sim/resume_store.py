"""Reusable SQLite storage for per-pair resume checkpoints.

The batch comparison path historically stores one JSON payload per row in a
``completed_pairs`` table.  This module keeps that schema and payload shape,
but gives callers a long-lived, single-owner writer and a bounded reader that
never materializes all SQLite rows at once.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
from typing import Any, Callable, Iterable, Mapping, MutableMapping


_UPSERT_SQL = (
    "INSERT INTO completed_pairs(pair_key, pair_json) VALUES(?, ?) "
    "ON CONFLICT(pair_key) DO UPDATE SET pair_json=excluded.pair_json"
)


@dataclass
class ResumeReadDiagnostics:
    """Counters for one bounded resume read."""

    read_batches: int = 0
    read_rows: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "read_batches": int(self.read_batches),
            "read_rows": int(self.read_rows),
        }


class ResumePairs(dict[str, Any]):
    """A normal resume mapping carrying read counters as side metadata."""

    def __init__(
        self,
        *args: Any,
        read_diagnostics: ResumeReadDiagnostics | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        diagnostics = read_diagnostics or ResumeReadDiagnostics()
        self.read_diagnostics = diagnostics

    @property
    def diagnostics(self) -> dict[str, int]:
        return self.read_diagnostics.as_dict()

    def stats(self) -> dict[str, int]:
        return self.diagnostics


def _connection_target(database_path: str | os.PathLike[str]) -> str | os.PathLike[str]:
    """Preserve SQLite's special in-memory target while accepting PathLike."""

    if isinstance(database_path, str) and database_path == ":memory:":
        return database_path
    return os.fspath(database_path)


def _validate_batch_size(batch_size: int) -> int:
    try:
        size = int(batch_size)
    except (TypeError, ValueError) as exc:
        raise TypeError("batch_size must be a positive integer") from exc
    if size != batch_size or size <= 0:
        raise ValueError("batch_size must be a positive integer")
    return size


def _update_read_diagnostics(
    diagnostics: ResumeReadDiagnostics,
    target: MutableMapping[str, int] | ResumeReadDiagnostics | None,
) -> None:
    """Copy counters into an optional caller-owned diagnostics sink."""

    if target is None or target is diagnostics:
        return
    if isinstance(target, ResumeReadDiagnostics):
        target.read_batches = diagnostics.read_batches
        target.read_rows = diagnostics.read_rows
        return
    target["read_batches"] = diagnostics.read_batches
    target["read_rows"] = diagnostics.read_rows


class ResumeSQLiteWriter:
    """Single-connection, main-thread writer for completed pair payloads.

    Construction performs the WAL/synchronous PRAGMAs and creates the
    historical ``completed_pairs(pair_key, pair_json)`` table once.  Each
    :meth:`write_pair` call upserts exactly one row and commits immediately,
    preserving the crash boundary used by the batch comparison code.
    """

    def __init__(
        self,
        database_path: str | os.PathLike[str],
        *,
        timeout: float = 30.0,
        max_attempts: int = 8,
        retry_delay: float = 0.12,
        sleep_fn: Callable[[float], None] = time.sleep,
        max_retries: int | None = None,
        retry_backoff: float | None = None,
        sleep: Callable[[float], None] | None = None,
    ) -> None:
        self.database_path = database_path
        self._owner_thread = threading.get_ident()
        self._closed = False
        self._writer_commits = 0
        self._writer_rows = 0
        self._writer_attempts = 0
        self._writer_retries = 0
        self._connection_inits = 0
        if max_retries is not None:
            max_attempts = int(max_retries) + 1
        if retry_backoff is not None:
            retry_delay = retry_backoff
        if sleep is not None:
            sleep_fn = sleep
        self._max_attempts = max(1, int(max_attempts))
        self._retry_delay = max(0.0, float(retry_delay))
        self._sleep_fn = sleep_fn

        target = _connection_target(database_path)
        if target != ":memory:":
            Path(target).parent.mkdir(parents=True, exist_ok=True)
        try:
            self._connection = sqlite3.connect(target, timeout=float(timeout))
            self._connection_inits = 1
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=NORMAL")
            self._connection.execute(
                "CREATE TABLE IF NOT EXISTS completed_pairs ("
                "pair_key TEXT PRIMARY KEY, pair_json TEXT NOT NULL"
                ")"
            )
            self._connection.commit()
        except BaseException:
            connection = getattr(self, "_connection", None)
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
            raise

    @property
    def connection(self) -> sqlite3.Connection:
        """Expose the owned connection for read-only inspection/testing."""

        self._check_owner_open()
        return self._connection

    @property
    def writer_commits(self) -> int:
        return int(self._writer_commits)

    @property
    def writer_rows(self) -> int:
        return int(self._writer_rows)

    @property
    def connection_inits(self) -> int:
        return int(self._connection_inits)

    @property
    def writer_attempts(self) -> int:
        return int(self._writer_attempts)

    @property
    def writer_retries(self) -> int:
        return int(self._writer_retries)

    @property
    def closed(self) -> bool:
        return self._closed

    def _check_owner_open(self) -> None:
        if threading.get_ident() != self._owner_thread:
            raise RuntimeError("ResumeSQLiteWriter must be used from its creating thread")
        if self._closed:
            raise RuntimeError("ResumeSQLiteWriter is closed")

    def write_pair(self, pair_key: str, pair: Any) -> None:
        """Upsert one JSON payload and commit it immediately."""

        self._check_owner_open()
        if not isinstance(pair_key, str):
            raise TypeError("pair_key must be a string")
        for attempt in range(self._max_attempts):
            self._writer_attempts += 1
            try:
                pair_json = json.dumps(pair, ensure_ascii=False, separators=(",", ":"))
                self._connection.execute(_UPSERT_SQL, (pair_key, pair_json))
                self._connection.commit()
            except (sqlite3.Error, OSError):
                try:
                    self._connection.rollback()
                except Exception:
                    pass
                if attempt + 1 >= self._max_attempts:
                    raise
                self._writer_retries += 1
                self._sleep_fn(self._retry_delay * (attempt + 1))
                continue
            except BaseException:
                try:
                    self._connection.rollback()
                except Exception:
                    pass
                raise
            self._writer_commits += 1
            self._writer_rows += 1
            return

    # Names used by small callers and migration code can remain explicit
    # aliases while sharing the same one-row/one-commit semantics.
    upsert_pair = write_pair
    save_pair = write_pair

    def write_pairs(self, pairs: Mapping[str, Any] | Iterable[tuple[str, Any]]) -> None:
        """Write an iterable one pair at a time, committing each pair."""

        self._check_owner_open()
        iterator = pairs.items() if isinstance(pairs, Mapping) else pairs
        for pair_key, pair in iterator:
            self.write_pair(pair_key, pair)

    upsert = write_pair
    store_pair = write_pair

    def diagnostics(self) -> dict[str, int]:
        return {
            "writer_commits": int(self._writer_commits),
            "writer_rows": int(self._writer_rows),
            "writer_attempts": int(self._writer_attempts),
            "writer_retries": int(self._writer_retries),
            "connection_inits": int(self._connection_inits),
        }

    def stats(self) -> dict[str, int]:
        return self.diagnostics()

    def close(self) -> None:
        """Close the owned connection; repeated close calls are harmless."""

        if threading.get_ident() != self._owner_thread:
            raise RuntimeError("ResumeSQLiteWriter must be closed from its creating thread")
        if self._closed:
            return
        self._connection.close()
        self._closed = True

    def __enter__(self) -> "ResumeSQLiteWriter":
        self._check_owner_open()
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()


def load_resume_pairs(
    database_path: str | os.PathLike[str],
    batch_size: int = 512,
    *,
    diagnostics: MutableMapping[str, int] | ResumeReadDiagnostics | None = None,
) -> ResumePairs:
    """Load completed pairs with repeated ``fetchmany`` calls.

    The return value is a ``dict`` subclass mapping each historical
    ``pair_key`` to its decoded JSON payload, including old payload versions.
    Invalid JSON rows are skipped as in the legacy batch loader.  Raw fetched
    rows count toward ``read_rows`` even when a row is skipped.
    """

    size = _validate_batch_size(batch_size)
    read_diagnostics = ResumeReadDiagnostics()
    result = ResumePairs(read_diagnostics=read_diagnostics)
    target = _connection_target(database_path)
    try:
        connection = sqlite3.connect(target, timeout=30)
    except (sqlite3.Error, OSError):
        _update_read_diagnostics(read_diagnostics, diagnostics)
        return result

    try:
        cursor = connection.execute("SELECT pair_key, pair_json FROM completed_pairs")
        while True:
            rows = cursor.fetchmany(size)
            if not rows:
                break
            read_diagnostics.read_batches += 1
            read_diagnostics.read_rows += len(rows)
            for pair_key, pair_json in rows:
                try:
                    pair = json.loads(pair_json)
                except (TypeError, json.JSONDecodeError):
                    continue
                if isinstance(pair_key, str):
                    result[pair_key] = pair
    except (sqlite3.Error, OSError):
        # Missing tables and interrupted reads retain the legacy safe-empty
        # behavior while still reporting rows already consumed.
        result.clear()
    finally:
        try:
            connection.close()
        finally:
            _update_read_diagnostics(read_diagnostics, diagnostics)
    return result


def load_resume_pairs_fetchmany(
    database_path: str | os.PathLike[str],
    batch_size: int = 512,
    *,
    diagnostics: MutableMapping[str, int] | ResumeReadDiagnostics | None = None,
) -> ResumePairs:
    """Explicitly named alias for the bounded ``fetchmany`` loader."""

    return load_resume_pairs(
        database_path,
        batch_size=batch_size,
        diagnostics=diagnostics,
    )


def read_resume_pairs(
    database_path: str | os.PathLike[str],
    batch_size: int = 512,
    *,
    diagnostics: MutableMapping[str, int] | ResumeReadDiagnostics | None = None,
) -> ResumePairs:
    """Compatibility alias for callers that call the operation a read."""

    return load_resume_pairs(
        database_path,
        batch_size=batch_size,
        diagnostics=diagnostics,
    )


load_resume_sqlite = load_resume_pairs


__all__ = [
    "ResumePairs",
    "ResumeReadDiagnostics",
    "ResumeSQLiteWriter",
    "load_resume_pairs",
    "load_resume_pairs_fetchmany",
    "load_resume_sqlite",
    "read_resume_pairs",
]
