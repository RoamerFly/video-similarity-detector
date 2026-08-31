import os
from pathlib import Path

import numpy as np

from video_sim.recognition_contract import (
    CONTAINMENT_SCORING_VERSION,
    FEATURE_EXTRACTOR_ID,
    REPORT_SCHEMA_VERSION,
    feature_cache_identity,
    pair_result_key,
)


class _Cache:
    def __init__(self, metadata, embeddings):
        self.metadata = metadata
        self.embeddings = embeddings


def test_contract_is_lightweight_and_has_expected_versions():
    assert REPORT_SCHEMA_VERSION == 2
    assert CONTAINMENT_SCORING_VERSION == 5
    assert FEATURE_EXTRACTOR_ID == "clip_vision_pooler_v1"


def test_pair_key_includes_both_cache_metadata_but_ignores_worker_tuning(tmp_path: Path):
    video_a = tmp_path / "a.mp4"
    video_b = tmp_path / "b.mp4"
    video_a.write_bytes(b"a")
    video_b.write_bytes(b"b")
    cache_a = _Cache({"schema_version": 4, "embedding_model": "model-a"}, [[1.0, 0.0]])
    cache_b = _Cache({"schema_version": 4, "embedding_model": "model-a"}, [[0.0, 1.0]])
    common = {
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "containment_scoring_version": CONTAINMENT_SCORING_VERSION,
        "feature_extractor_id": FEATURE_EXTRACTOR_ID,
        "frame_cache_schema_version": 4,
        "embedding_model_fingerprint": "model-a",
        "embedding_runtime": "precision=fp32",
        "candidate_limit": 2,
        "compare_workers": 4,
    }
    key_a = pair_result_key(
        video_a,
        video_b,
        cache_a_identity=feature_cache_identity(cache_a),
        cache_b_identity=feature_cache_identity(cache_b),
        pair_parameters_value={"match_threshold": 0.65},
        global_identity=common,
    )
    common["candidate_limit"] = 20
    common["compare_workers"] = 1
    key_b = pair_result_key(
        video_b,
        video_a,
        cache_a_identity=feature_cache_identity(cache_b),
        cache_b_identity=feature_cache_identity(cache_a),
        pair_parameters_value={"match_threshold": 0.65},
        global_identity=common,
    )
    assert key_a == key_b

    cache_b.metadata["embedding_model"] = "model-b"
    key_c = pair_result_key(
        video_a,
        video_b,
        cache_a_identity=feature_cache_identity(cache_a),
        cache_b_identity=feature_cache_identity(cache_b),
        pair_parameters_value={"match_threshold": 0.65},
        global_identity=common,
    )
    assert key_c != key_a


def test_pair_key_changes_when_npz_artifact_content_changes(tmp_path: Path):
    video_a = tmp_path / "a.mp4"
    video_b = tmp_path / "b.mp4"
    artifact = tmp_path / "cache.npz"
    video_a.write_bytes(b"a")
    video_b.write_bytes(b"b")
    cache = _Cache({"schema_version": 4}, [[1.0]])

    fixed_mtime_ns = 1_700_000_000_000_000_000
    np.savez_compressed(artifact, embeddings=np.array([[1.0, 2.0]], dtype=np.float32))
    os.utime(artifact, ns=(fixed_mtime_ns, fixed_mtime_ns))
    identity_a = feature_cache_identity(cache, artifact)
    assert identity_a == feature_cache_identity(cache, artifact)

    np.savez_compressed(artifact, embeddings=np.array([[3.0, 4.0]], dtype=np.float32))
    os.utime(artifact, ns=(fixed_mtime_ns, fixed_mtime_ns))
    identity_b = feature_cache_identity(cache, artifact)
    assert identity_a["artifact"]["content_identity"] == "zip_manifest"
    assert identity_a != identity_b
    kwargs = {
        "pair_parameters_value": {},
        "global_identity": {"containment_scoring_version": 5},
    }
    assert pair_result_key(video_a, video_b, cache_a_identity=identity_a, **kwargs) != pair_result_key(
        video_a, video_b, cache_a_identity=identity_b, **kwargs
    )


def test_non_zip_artifact_uses_partial_identity_for_same_size_rewrite(tmp_path: Path):
    artifact = tmp_path / "cache.npz"
    fixed_mtime_ns = 1_700_000_000_000_000_000
    cache = _Cache({"schema_version": 4}, [[1.0]])

    artifact.write_bytes(b"one")
    os.utime(artifact, ns=(fixed_mtime_ns, fixed_mtime_ns))
    identity_a = feature_cache_identity(cache, artifact)

    artifact.write_bytes(b"two")
    os.utime(artifact, ns=(fixed_mtime_ns, fixed_mtime_ns))
    identity_b = feature_cache_identity(cache, artifact)

    assert identity_a["artifact"]["content_identity"] == "partial_head_tail"
    assert identity_a["artifact"]["partial"] is True
    assert identity_a != identity_b
