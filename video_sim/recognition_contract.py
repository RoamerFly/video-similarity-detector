"""Stable identities shared by recognition reports and resumable pair work.

This module deliberately has no dependency on torch, FAISS, a decoder, or the
embedding implementation.  It is imported by lightweight command line and
reporting code, so importing it must not initialize the video runtime.
"""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path
from typing import Any, Mapping


REPORT_SCHEMA_VERSION = 2
CONTAINMENT_SCORING_VERSION = 5
FEATURE_EXTRACTOR_ID = "clip_vision_pooler_v1"

# Kept here as a lightweight contract value.  The batch runner also records
# the value from video_sim.embedder when the runtime is available.  Keeping a
# fallback lets report/key helpers remain usable in tooling and tests that do
# not install torch.
FRAME_CACHE_SCHEMA_VERSION = 4

PAIR_PARAMETER_KEYS = (
    "match_threshold",
    "top_k",
    "window_size",
    "min_segment_duration",
    "min_segment_matches",
    "offset_tolerance",
    "early_stop",
)


_ARTIFACT_SAMPLE_BYTES = 64 * 1024


def report_version_fields() -> dict[str, int]:
    """Return the version fields required on modern report payloads."""

    return {
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "containment_scoring_version": CONTAINMENT_SCORING_VERSION,
    }


def canonical_json(value: Any) -> str:
    """Encode JSON values deterministically for cache identity hashing."""

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def digest_payload(value: Any, *, prefix: str = "sha256:") -> str:
    """Return a short, deterministic digest suitable for a result key."""

    digest = hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
    return f"{prefix}{digest}"


def file_identity(path: str | Path) -> dict[str, Any]:
    """Return a source file identity without reading the media contents."""

    candidate = Path(path)
    try:
        resolved = candidate.resolve(strict=False)
        stat = candidate.stat()
        return {
            "path": str(resolved),
            "size": int(stat.st_size),
            "mtime_ns": int(stat.st_mtime_ns),
        }
    except OSError:
        return {
            "path": str(candidate.resolve(strict=False)),
            "size": None,
            "mtime_ns": None,
        }


def _zip_manifest_digest(path: Path) -> str:
    """Hash ZIP central-directory metadata without reading member contents."""

    with zipfile.ZipFile(path, mode="r") as archive:
        manifest = sorted(
            (
                info.filename,
                int(info.CRC),
                int(info.file_size),
                int(info.compress_size),
            )
            for info in archive.infolist()
        )
    return digest_payload(manifest)


def _partial_file_digest(path: Path, size: int) -> str:
    """Hash bounded head/tail samples for a non-ZIP artifact."""

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        head = stream.read(_ARTIFACT_SAMPLE_BYTES)
        digest.update(b"head\0")
        digest.update(head)

        if size > _ARTIFACT_SAMPLE_BYTES:
            # Keep the total sampled bytes bounded when the file is small
            # enough for the head and tail windows to overlap.
            tail_offset = max(_ARTIFACT_SAMPLE_BYTES, size - _ARTIFACT_SAMPLE_BYTES)
            stream.seek(tail_offset)
            tail = stream.read(min(_ARTIFACT_SAMPLE_BYTES, size - tail_offset))
        else:
            tail = b""
        digest.update(b"tail\0")
        digest.update(tail)
    return f"sha256:{digest.hexdigest()}"


def _artifact_identity(path: str | Path) -> dict[str, Any]:
    """Return file stats plus a bounded identity for a cache artifact."""

    candidate = Path(path)
    identity = file_identity(candidate)
    size = identity.get("size")
    if not isinstance(size, int):
        identity.update(
            {
                "content_identity": "unavailable",
                "content_digest": None,
                "partial": True,
            }
        )
        return identity

    try:
        # ZipFile parses the end-of-central-directory record and central
        # directory on construction/infolist(); no member is decompressed.
        identity.update(
            {
                "content_identity": "zip_manifest",
                "content_digest": _zip_manifest_digest(candidate),
                "partial": False,
            }
        )
    except zipfile.BadZipFile:
        try:
            identity.update(
                {
                    "content_identity": "partial_head_tail",
                    "content_digest": _partial_file_digest(candidate, size),
                    "partial": True,
                }
            )
        except OSError:
            identity.update(
                {
                    "content_identity": "unavailable",
                    "content_digest": None,
                    "partial": True,
                }
            )
    except OSError:
        identity.update(
            {
                "content_identity": "unavailable",
                "content_digest": None,
                "partial": True,
            }
        )
    return identity


def feature_cache_identity(
    cache: Any,
    cache_path: str | Path | None = None,
) -> dict[str, Any]:
    """Summarize a loaded feature cache without re-reading its NPZ arrays.

    Cache metadata is intentionally hashed once during the batch cache audit;
    pair scheduling can then use this small identity repeatedly.  Shape and
    dtype protect against a malformed cache whose metadata was copied from a
    different array.  The optional artifact identity detects an in-place cache
    rewrite even when its JSON metadata was left unchanged.
    """

    metadata = getattr(cache, "metadata", None)
    metadata = dict(metadata) if isinstance(metadata, Mapping) else {}
    embeddings = getattr(cache, "embeddings", None)
    shape = list(getattr(embeddings, "shape", ()))
    dtype = str(getattr(embeddings, "dtype", ""))
    identity: dict[str, Any] = {
        "schema_version": metadata.get("schema_version", FRAME_CACHE_SCHEMA_VERSION),
        "metadata_digest": digest_payload(metadata),
        "embedding_shape": shape,
        "embedding_dtype": dtype,
    }
    if cache_path is not None:
        identity["artifact"] = _artifact_identity(cache_path)
    return identity


def pair_parameters(values: Mapping[str, Any]) -> dict[str, Any]:
    """Select only settings that can change a completed pair result."""

    return {
        key: values[key]
        for key in PAIR_PARAMETER_KEYS
        if key in values
    }


def pair_result_key(
    video_a: str | Path,
    video_b: str | Path,
    *,
    cache_a_identity: Mapping[str, Any] | None = None,
    cache_b_identity: Mapping[str, Any] | None = None,
    pair_parameters_value: Mapping[str, Any] | None = None,
    global_identity: Mapping[str, Any] | None = None,
) -> str:
    """Build a symmetric key for a fully materialized pair result.

    The source/cache entries are sorted together, preserving symmetry while
    ensuring that each side's feature metadata participates in the identity.
    Global model/extractor/scoring values are accepted separately from pair
    parameters so callers cannot accidentally include candidate or worker
    tuning in result semantics.
    """

    entries = [
        {
            "file": file_identity(video_a),
            "cache": dict(cache_a_identity or {}),
        },
        {
            "file": file_identity(video_b),
            "cache": dict(cache_b_identity or {}),
        },
    ]
    entries.sort(key=canonical_json)
    global_values = dict(global_identity or {})
    # Explicitly whitelist the global contract fields.  In particular, a
    # caller's candidate_limit/compare_workers cannot poison pair identity.
    global_values = {
        key: global_values[key]
        for key in (
            "report_schema_version",
            "containment_scoring_version",
            "feature_extractor_id",
            "frame_cache_schema_version",
            "embedding_model_fingerprint",
            "embedding_runtime",
        )
        if key in global_values
    }
    payload = {
        "contract": REPORT_SCHEMA_VERSION,
        "global": global_values,
        "parameters": dict(pair_parameters_value or {}),
        "videos": entries,
    }
    return f"pair-v{REPORT_SCHEMA_VERSION}:{digest_payload(payload, prefix='')}"


def is_current_report_pair(pair: Any) -> bool:
    """Return whether a saved pair has explicit modern report semantics."""

    if not isinstance(pair, Mapping):
        return False
    return (
        pair.get("report_schema_version") == REPORT_SCHEMA_VERSION
        and pair.get("containment_scoring_version") == CONTAINMENT_SCORING_VERSION
    )


def is_current_report(value: Any) -> bool:
    """Return whether a top-level report uses the current schema/version."""

    return (
        isinstance(value, Mapping)
        and value.get("report_schema_version") == REPORT_SCHEMA_VERSION
        and value.get("containment_scoring_version") == CONTAINMENT_SCORING_VERSION
    )
