"""Persistent, validated candidate-stage summaries.

The summary is deliberately a sidecar of ``frame_features.npz``.  It keeps
all timestamps and auxiliary signatures (so sidecar storage is O(N) in frame
count), while limiting only the embedding sketches used by the candidate
selector.  A sidecar is an optimization: the frame cache remains the source
of truth and is never removed because a sidecar is missing or malformed.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import threading
import uuid
import zipfile
from typing import Any, Mapping

import numpy as np

from video_sim.recognition_contract import (
    artifact_identity,
    canonical_json,
    feature_cache_identity_from_parts,
)


SUMMARY_SCHEMA_VERSION = 1
# Bump this explicitly whenever the persisted representation or selector
# semantics change.  It is intentionally a string so reports can display it.
CANDIDATE_SELECTOR_VERSION = "candidate_selector_v1"
SUMMARY_PARAMS = {
    "representatives_per_video": 64,
    "max_index_frames_per_video": 1024,
    "window_seconds": 30.0,
    "max_windows_per_video": 96,
}
ALLOWED_AUXILIARY_KINDS = {"phash", "simhash"}
_MAX_ARRAY_BYTES = 512 * 1024 * 1024
# These limits are applied to ZIP central-directory metadata before NumPy is
# allowed to open any member.  They protect the audit path from a compressed
# member whose uncompressed size would otherwise be allocated by ``np.load``.
_MAX_ARCHIVE_MEMBERS = 7
_MAX_ARCHIVE_MEMBER_BYTES = 128 * 1024 * 1024
_MAX_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024
_MAX_ARCHIVE_METADATA_BYTES = 1 * 1024 * 1024
_SUMMARY_MEMBER_NAMES = frozenset(
    {
        "timestamps.npy",
        "optimized_source_representatives.npy",
        "optimized_index_embeddings.npy",
        "auxiliary_signatures.npy",
        "baseline_source_representatives.npy",
        "baseline_index_embeddings.npy",
        "metadata.npy",
    }
)


def candidate_summary_path(cache_path: str | Path) -> Path:
    """Return the fixed sidecar path next to a frame cache artifact."""

    path = Path(cache_path)
    if path.name != "frame_features.npz":
        # Callers often pass the cache directory or an older arbitrary NPZ;
        # using the containing directory keeps the public helper forgiving.
        return path.parent / "candidate_summary.npz"
    return path.with_name("candidate_summary.npz")


def _normalise_params(value: Mapping[str, Any] | None) -> dict[str, Any]:
    params = dict(SUMMARY_PARAMS)
    if value:
        supplied = dict(value)
        unknown = set(supplied).difference(SUMMARY_PARAMS)
        if unknown:
            raise ValueError(f"candidate summary parameters contain unknown keys: {sorted(unknown)}")
        params.update(supplied)
    result = {
        "representatives_per_video": int(params["representatives_per_video"]),
        "max_index_frames_per_video": int(params["max_index_frames_per_video"]),
        "window_seconds": float(params["window_seconds"]),
        "max_windows_per_video": int(params["max_windows_per_video"]),
    }
    if (
        result["representatives_per_video"] <= 0
        or result["max_index_frames_per_video"] <= 0
        or result["max_windows_per_video"] <= 0
        or not np.isfinite(result["window_seconds"])
        or result["window_seconds"] <= 0
    ):
        raise ValueError("candidate summary parameters are invalid")
    return result


def _as_jsonable(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(k): _as_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_as_jsonable(v) for v in value]
    if isinstance(value, np.generic):
        return value.item()
    return value


def _metadata_from_summary(summary: Any, explicit: Mapping[str, Any] | None) -> dict[str, Any]:
    metadata = explicit if explicit is not None else getattr(summary, "cache_metadata", None)
    return dict(metadata) if isinstance(metadata, Mapping) else {}


def _shape_from_summary(summary: Any) -> list[int]:
    shape = getattr(summary, "embedding_shape", None)
    if shape is not None:
        return [int(v) for v in shape]
    frame_count = int(getattr(summary, "frame_count", 0))
    source = np.asarray(getattr(summary, "optimized_source_representatives"))
    dimension = int(source.shape[1]) if source.ndim == 2 and source.shape[1] else 0
    return [frame_count, dimension]


def _dtype_from_summary(summary: Any) -> str:
    value = getattr(summary, "embedding_dtype", None)
    if value:
        return str(value)
    source = np.asarray(getattr(summary, "optimized_source_representatives"))
    return str(source.dtype)


def _array(value: Any, name: str, *, dtype: str | None = None) -> np.ndarray:
    array = np.asarray(value)
    if array.dtype.hasobject:
        raise ValueError(f"candidate summary {name} cannot contain object arrays")
    if dtype is not None and array.dtype != np.dtype(dtype):
        raise ValueError(f"candidate summary {name} has dtype {array.dtype}, expected {dtype}")
    if int(array.nbytes) > _MAX_ARRAY_BYTES:
        raise ValueError(f"candidate summary {name} exceeds the safety byte limit")
    return array


def _validate_summary_arrays(summary: Any, metadata: Mapping[str, Any], params: Mapping[str, Any]) -> None:
    frame_count = int(getattr(summary, "frame_count", -1))
    if frame_count < 0:
        raise ValueError("candidate summary frame_count is invalid")
    expected_count = metadata.get("retained_frame_count", metadata.get("frame_count", frame_count))
    try:
        if int(expected_count) != frame_count:
            raise ValueError("candidate summary frame_count does not match cache metadata")
    except (TypeError, ValueError) as exc:
        raise ValueError("candidate summary cache frame_count is invalid") from exc

    timestamps = _array(getattr(summary, "timestamps"), "timestamps")
    if timestamps.ndim != 1 or timestamps.dtype not in (np.dtype("float32"), np.dtype("float64")):
        raise ValueError("candidate summary timestamps must be a float32/float64 vector")
    if len(timestamps) != frame_count:
        raise ValueError("candidate summary timestamps length does not match frame_count")
    if int(timestamps.nbytes) > frame_count * 8:
        raise ValueError("candidate summary timestamps exceed frame_count byte budget")
    if not np.all(np.isfinite(timestamps)):
        raise ValueError("candidate summary timestamps contain non-finite values")

    auxiliary = _array(getattr(summary, "auxiliary_signatures"), "auxiliary_signatures", dtype="uint64")
    if auxiliary.ndim != 1 or len(auxiliary) != frame_count:
        raise ValueError("candidate summary auxiliary_signatures length does not match frame_count")
    if int(auxiliary.nbytes) > frame_count * 8:
        raise ValueError("candidate summary auxiliary_signatures exceed frame_count byte budget")
    kind = str(getattr(summary, "auxiliary_kind", ""))
    if kind not in ALLOWED_AUXILIARY_KINDS:
        raise ValueError(f"unknown candidate summary auxiliary kind: {kind!r}")

    shape = _shape_from_summary(summary)
    if len(shape) != 2 or shape[0] != frame_count or shape[1] <= 0:
        raise ValueError("candidate summary embedding_shape is invalid")
    dimension = shape[1]
    for name in ("optimized_source_representatives", "optimized_index_embeddings"):
        value = _array(getattr(summary, name), name, dtype="float32")
        if value.ndim != 2 or value.shape[1] != dimension:
            raise ValueError(f"candidate summary {name} shape does not match embedding dimension")
        maximum = min(frame_count, int(params["representatives_per_video"])) if name.endswith("source_representatives") else min(frame_count, int(params["max_index_frames_per_video"]))
        if len(value) > maximum:
            raise ValueError(f"candidate summary {name} exceeds its configured sketch limit")
        if int(value.nbytes) > maximum * dimension * np.dtype("float32").itemsize:
            raise ValueError(f"candidate summary {name} exceeds its configured byte budget")
        if frame_count and len(value) == 0:
            raise ValueError(f"candidate summary {name} is empty")
        if not np.all(np.isfinite(value)):
            raise ValueError(f"candidate summary {name} contains non-finite values")
    for name in ("baseline_source_representatives", "baseline_index_embeddings"):
        value = getattr(summary, name, None)
        if value is None:
            continue
        baseline = _array(value, name, dtype="float32")
        if baseline.ndim != 2 or baseline.shape[1] != dimension:
            raise ValueError(f"candidate summary {name} shape does not match embedding dimension")
        if name == "baseline_source_representatives":
            base_limit = max(4, int(params["representatives_per_video"]))
        else:
            base_limit = max(
                int(params["representatives_per_video"]),
                int(params["max_index_frames_per_video"]),
            )
        baseline_limit = min(frame_count, base_limit) + min(
            frame_count, int(params["max_windows_per_video"])
        )
        if len(baseline) > baseline_limit or int(baseline.nbytes) > baseline_limit * dimension * np.dtype("float32").itemsize:
            raise ValueError(f"candidate summary {name} exceeds its safety byte budget")
        if not np.all(np.isfinite(baseline)):
            raise ValueError(f"candidate summary {name} contains non-finite values")


def _metadata_payload(
    summary: Any,
    metadata: Mapping[str, Any],
    source_cache_path: Path,
    params: Mapping[str, Any],
    selector_version: str,
    identity: Mapping[str, Any] | None,
    artifact_identity_callback: Any = None,
) -> dict[str, Any]:
    shape = _shape_from_summary(summary)
    dtype = _dtype_from_summary(summary)
    # Compute the central-directory manifest once and reuse it for both the
    # source field and feature-cache identity.
    if artifact_identity_callback is not None:
        artifact_identity_callback()
    source_identity = artifact_identity(source_cache_path)
    cache_identity = dict(identity or feature_cache_identity_from_parts(metadata, shape, dtype, None))
    cache_identity.setdefault("artifact", source_identity)
    return {
        "summary_schema_version": SUMMARY_SCHEMA_VERSION,
        "selector_version": str(selector_version),
        "auxiliary_kind": str(summary.auxiliary_kind),
        "summary_params": dict(params),
        "cache_metadata": _as_jsonable(dict(metadata)),
        "feature_cache_identity": _as_jsonable(cache_identity),
        "feature_cache_identity_parts": {
            "metadata": _as_jsonable(dict(metadata)),
            "embedding_shape": shape,
            "embedding_dtype": dtype,
            "path": str(source_cache_path.resolve(strict=False)),
        },
        "embedding_shape": shape,
        "embedding_dtype": dtype,
        "source_artifact_identity": _as_jsonable(source_identity),
    }


def save_candidate_summary(
    summary: Any,
    path: str | Path,
    *,
    cache_metadata: Mapping[str, Any] | None = None,
    source_cache_path: str | Path | None = None,
    feature_cache_identity: Mapping[str, Any] | None = None,
    summary_params: Mapping[str, Any] | None = None,
    selector_version: str = CANDIDATE_SELECTOR_VERSION,
    metadata: Mapping[str, Any] | None = None,
    cache_identity: Mapping[str, Any] | None = None,
    artifact_identity_callback: Any = None,
) -> Path:
    """Atomically write a compressed summary sidecar.

    ``path`` may be either the intended sidecar path or the corresponding
    ``frame_features.npz`` path.  Temporary names include process and thread
    identity so concurrent analyses never share a temporary file.
    """

    destination = candidate_summary_path(path)
    source = Path(source_cache_path) if source_cache_path is not None else (
        Path(path) if Path(path).name == "frame_features.npz" else destination.parent / "frame_features.npz"
    )
    if cache_metadata is None:
        cache_metadata = metadata
    if feature_cache_identity is None:
        feature_cache_identity = cache_identity
    if summary_params is None:
        summary_params = getattr(summary, "summary_params", None)
    params = _normalise_params(summary_params)
    metadata = _metadata_from_summary(summary, cache_metadata)
    _validate_summary_arrays(summary, metadata, params)
    payload = _metadata_payload(
        summary,
        metadata,
        source,
        params,
        selector_version,
        feature_cache_identity,
        artifact_identity_callback,
    )
    summary.feature_cache_identity = dict(payload["feature_cache_identity"])
    summary.cache_metadata = dict(metadata)
    summary.summary_params = dict(params)
    summary.embedding_shape = tuple(int(value) for value in payload["embedding_shape"])
    summary.embedding_dtype = str(payload["embedding_dtype"])
    arrays: dict[str, np.ndarray] = {
        "timestamps": _array(summary.timestamps, "timestamps"),
        "optimized_source_representatives": _array(summary.optimized_source_representatives, "optimized_source_representatives", dtype="float32"),
        "optimized_index_embeddings": _array(summary.optimized_index_embeddings, "optimized_index_embeddings", dtype="float32"),
        "auxiliary_signatures": _array(summary.auxiliary_signatures, "auxiliary_signatures", dtype="uint64"),
        "metadata": np.asarray(canonical_json(payload), dtype=np.str_),
    }
    for name in ("baseline_source_representatives", "baseline_index_embeddings"):
        value = getattr(summary, name, None)
        if value is not None:
            arrays[name] = _array(value, name, dtype="float32")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(
        f".{destination.name}.tmp-{os.getpid()}-{threading.get_ident()}-{uuid.uuid4().hex}"
    )
    try:
        with open(temporary, "wb") as stream:
            np.savez_compressed(stream, **arrays)
            stream.flush()
            try:
                os.fsync(stream.fileno())
            except OSError:
                pass
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return destination


def _read_metadata(raw: Any) -> dict[str, Any]:
    if isinstance(raw, np.ndarray):
        if raw.dtype.hasobject or raw.shape != ():
            raise ValueError("candidate summary metadata must be a scalar string")
        raw = raw.item()
    if not isinstance(raw, (str, bytes, np.str_)):
        raise ValueError("candidate summary metadata must be a scalar string")
    try:
        value = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else str(raw))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("candidate summary metadata is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("candidate summary metadata must be a JSON object")
    return value


def _preflight_sidecar_archive(path: Path) -> None:
    """Validate ZIP member names and sizes before NumPy opens the archive.

    ``np.load`` reads the ZIP central directory and then allocates each array
    from the member's advertised shape.  A malformed or hostile sidecar must
    therefore be rejected using central-directory metadata first.  The
    preflight intentionally permits only the exact members emitted by
    :func:`save_candidate_summary`; baseline members remain optional.
    """

    try:
        with zipfile.ZipFile(path, "r") as archive:
            infos = archive.infolist()
    except (OSError, zipfile.BadZipFile, ValueError) as exc:
        raise ValueError("candidate summary is not a valid ZIP archive") from exc

    if not infos or len(infos) > _MAX_ARCHIVE_MEMBERS:
        raise ValueError("candidate summary has an invalid member count")
    names: set[str] = set()
    total_size = 0
    for info in infos:
        name = str(info.filename)
        # Exact names also reject path traversal, directories, and duplicate
        # logical arrays before any extraction occurs.
        if name not in _SUMMARY_MEMBER_NAMES:
            raise ValueError(f"candidate summary has an unknown ZIP member: {name!r}")
        if name in names:
            raise ValueError(f"candidate summary has a duplicate ZIP member: {name!r}")
        names.add(name)
        if info.is_dir() or (int(info.flag_bits) & 0x1):
            raise ValueError(f"candidate summary ZIP member is not a plain file: {name!r}")
        try:
            member_size = int(info.file_size)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"candidate summary ZIP member size is invalid: {name!r}") from exc
        maximum = (
            _MAX_ARCHIVE_METADATA_BYTES
            if name == "metadata.npy"
            else _MAX_ARCHIVE_MEMBER_BYTES
        )
        if member_size < 0 or member_size > maximum:
            raise ValueError(f"candidate summary ZIP member is oversized: {name!r}")
        total_size += member_size
        if total_size > _MAX_ARCHIVE_TOTAL_BYTES:
            raise ValueError("candidate summary ZIP archive is oversized")


def _equal_json(left: Any, right: Any) -> bool:
    return canonical_json(left) == canonical_json(right)


def load_candidate_summary(
    path: str | Path,
    *,
    expected_cache_metadata: Mapping[str, Any] | None = None,
    source_cache_path: str | Path | None = None,
    expected_feature_cache_identity: Mapping[str, Any] | None = None,
    expected_summary_params: Mapping[str, Any] | None = None,
    expected_selector_version: str = CANDIDATE_SELECTOR_VERSION,
    expected_metadata: Mapping[str, Any] | None = None,
    cache_path: str | Path | None = None,
    artifact_identity_callback: Any = None,
    source_artifact_identity: Mapping[str, Any] | None = None,
) -> Any:
    """Load and validate a summary; raise ``ValueError`` for any miss reason."""

    from video_sim.candidate_selector import CandidateVideoSummary

    sidecar = candidate_summary_path(path)
    if expected_cache_metadata is None:
        expected_cache_metadata = expected_metadata
    if source_cache_path is None:
        source_cache_path = cache_path
    source = Path(source_cache_path) if source_cache_path is not None else sidecar.parent / "frame_features.npz"
    if not sidecar.is_file():
        raise FileNotFoundError(f"candidate summary sidecar not found: {sidecar}")
    # Inspect only the ZIP central directory before NumPy can allocate any
    # array advertised by a sidecar member.
    _preflight_sidecar_archive(sidecar)
    with np.load(sidecar, allow_pickle=False) as data:
        required = {"timestamps", "optimized_source_representatives", "optimized_index_embeddings", "auxiliary_signatures", "metadata"}
        missing = required.difference(data.files)
        if missing:
            raise ValueError(f"candidate summary missing arrays: {sorted(missing)}")
        payload = _read_metadata(data["metadata"])
        if payload.get("summary_schema_version") != SUMMARY_SCHEMA_VERSION:
            raise ValueError("candidate summary schema version is unsupported")
        if str(payload.get("selector_version")) != str(expected_selector_version):
            raise ValueError("candidate summary selector version is stale")
        raw_params = payload.get("summary_params")
        if not isinstance(raw_params, Mapping) or set(raw_params) != set(SUMMARY_PARAMS):
            raise ValueError("candidate summary parameters are missing or unknown")
        params = _normalise_params(raw_params)
        expected_params = SUMMARY_PARAMS if expected_summary_params is None else expected_summary_params
        if params != _normalise_params(expected_params):
            raise ValueError("candidate summary parameters do not match")
        metadata = payload.get("cache_metadata")
        if not isinstance(metadata, Mapping):
            raise ValueError("candidate summary cache metadata is missing")
        if expected_cache_metadata is not None:
            from video_sim.embedder import FrameEmbeddingCache

            if not FrameEmbeddingCache.is_metadata_fresh(dict(metadata), dict(expected_cache_metadata)):
                raise ValueError("candidate summary cache metadata is stale")
        shape = payload.get("embedding_shape")
        dtype = payload.get("embedding_dtype")
        if not isinstance(shape, list) or len(shape) != 2 or not isinstance(dtype, str):
            raise ValueError("candidate summary embedding identity is missing")
        parts = payload.get("feature_cache_identity_parts")
        expected_parts = {
            "metadata": dict(metadata),
            "embedding_shape": [int(value) for value in shape],
            "embedding_dtype": dtype,
            "path": str(source.resolve(strict=False)),
        }
        if not isinstance(parts, Mapping) or not _equal_json(parts, expected_parts):
            raise ValueError("candidate summary feature identity parts are inconsistent")
        stored_identity = payload.get("feature_cache_identity")
        if not isinstance(stored_identity, Mapping):
            raise ValueError("candidate summary feature identity is missing")
        # The artifact manifest is read once per audit.  Reusing it here keeps
        # the metric meaningful and avoids a second central-directory scan.
        if source_artifact_identity is None:
            if artifact_identity_callback is not None:
                artifact_identity_callback()
            current_artifact = artifact_identity(source)
        else:
            current_artifact = dict(source_artifact_identity)
        rebuilt = feature_cache_identity_from_parts(metadata, shape, dtype, None)
        rebuilt["artifact"] = current_artifact
        if not _equal_json(stored_identity, rebuilt):
            raise ValueError("candidate summary feature identity is inconsistent")
        stored_artifact = payload.get("source_artifact_identity")
        if not isinstance(stored_artifact, Mapping) or not _equal_json(stored_artifact, current_artifact):
            raise ValueError("candidate summary source artifact identity is stale")
        if expected_feature_cache_identity is not None and not _equal_json(stored_identity, expected_feature_cache_identity):
            raise ValueError("candidate summary feature identity does not match cache")

        kwargs: dict[str, Any] = {
            "video_path": str(metadata.get("video_path", "")),
            "frame_count": int(metadata.get("retained_frame_count", metadata.get("frame_count", len(data["timestamps"])))),
            "duration_seconds": float(metadata.get("duration_sec", metadata.get("retained_duration_sec", 0.0)) or 0.0),
            "timestamps": np.array(data["timestamps"], copy=True),
            "optimized_source_representatives": np.array(data["optimized_source_representatives"], copy=True),
            "optimized_index_embeddings": np.array(data["optimized_index_embeddings"], copy=True),
            "auxiliary_signatures": np.array(data["auxiliary_signatures"], copy=True),
            "auxiliary_kind": str(payload.get("auxiliary_kind", "")),
            "embedding_shape": tuple(int(v) for v in shape),
            "embedding_dtype": dtype,
            "cache_metadata": dict(metadata),
            "feature_cache_identity": dict(stored_identity),
            "summary_params": dict(params),
        }
        for name in ("baseline_source_representatives", "baseline_index_embeddings"):
            kwargs[name] = np.array(data[name], copy=True) if name in data.files else None
        summary = CandidateVideoSummary(**kwargs)
        _validate_summary_arrays(summary, metadata, params)
        return summary


def try_load_candidate_summary(*args: Any, **kwargs: Any) -> tuple[Any | None, str | None]:
    """Return ``(summary, None)`` on hit or ``(None, reason)`` on miss."""

    try:
        return load_candidate_summary(*args, **kwargs), None
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"


load_valid_candidate_summary = try_load_candidate_summary
load_candidate_summary_valid = try_load_candidate_summary

# Small compatibility aliases keep call sites readable and make the store
# usable from lightweight tooling without depending on its internal names.
summary_path = candidate_summary_path
save_summary = save_candidate_summary
load_summary = load_candidate_summary
