from pathlib import Path
import zipfile

import numpy as np
import pytest

from video_sim.candidate_selector import build_candidate_summary
from video_sim.candidate_selector import select_candidate_pairs
from video_sim.candidate_summary_store import (
    CANDIDATE_SELECTOR_VERSION,
    SUMMARY_PARAMS,
    SUMMARY_SCHEMA_VERSION,
    candidate_summary_path,
    load_candidate_summary,
    save_candidate_summary,
)
from video_sim.embedder import FrameEmbeddingCache
from video_sim.preprocess import PreprocessConfig
from video_sim.recognition_contract import (
    artifact_identity,
    feature_cache_identity,
    feature_cache_identity_from_parts,
)


def _fixture(tmp_path: Path, count: int = 12):
    tmp_path.mkdir(parents=True, exist_ok=True)
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"source")
    cache_path = tmp_path / "cache" / "frame_features.npz"
    values = np.eye(4, dtype="float32")[[i % 4 for i in range(count)]].copy()
    config = PreprocessConfig()
    metadata = FrameEmbeddingCache.build_metadata(video, 0.4, 45.0, 1, config)
    metadata["retained_frame_count"] = count
    cache = FrameEmbeddingCache(
        video_path=str(video),
        frame_indices=np.arange(count, dtype=np.int64),
        timestamps=np.arange(count, dtype=np.float64),
        phashes=["bad"] * count,
        thumbnail_paths=[],
        embeddings=values,
        preprocess_config=config,
        metadata=metadata,
    )
    cache.save(cache_path)
    return video, cache_path, cache, build_candidate_summary(cache, max_index_frames_per_video=1024)


def test_roundtrip_is_atomic_and_identity_matches_loaded_cache(tmp_path: Path):
    _, cache_path, cache, summary = _fixture(tmp_path)
    sidecar = save_candidate_summary(summary, cache_path, cache_metadata=cache.metadata)
    assert sidecar == candidate_summary_path(cache_path)
    assert sidecar.exists()
    assert not list(sidecar.parent.glob("*.tmp-*"))
    loaded = load_candidate_summary(
        sidecar,
        expected_cache_metadata=cache.metadata,
        source_cache_path=cache_path,
    )
    assert loaded.timestamps.tolist() == summary.timestamps.tolist()
    assert loaded.auxiliary_signatures.tolist() == summary.auxiliary_signatures.tolist()
    assert loaded.feature_cache_identity == feature_cache_identity(cache, cache_path)
    assert loaded.feature_cache_identity == feature_cache_identity_from_parts(
        cache.metadata, cache.embeddings.shape, cache.embeddings.dtype, cache_path
    )


def test_builder_custom_index_limit_roundtrips_while_production_default_stays_strict(tmp_path: Path):
    _, cache_path, cache, _ = _fixture(tmp_path, count=1100)
    summary = build_candidate_summary(cache, max_index_frames_per_video=2048)
    save_candidate_summary(summary, cache_path, cache_metadata=cache.metadata)
    loaded = load_candidate_summary(
        cache_path,
        expected_cache_metadata=cache.metadata,
        source_cache_path=cache_path,
        expected_summary_params=summary.summary_params,
    )
    assert len(loaded.optimized_index_embeddings) <= 2048
    with pytest.raises(ValueError, match="parameters"):
        load_candidate_summary(cache_path, expected_cache_metadata=cache.metadata, source_cache_path=cache_path)


@pytest.mark.parametrize(
    "mutate,match",
    [
        (lambda s: setattr(s, "auxiliary_kind", "unknown"), "unknown"),
        (lambda s: setattr(s, "timestamps", s.timestamps[:-1]), "length"),
        (lambda s: s.optimized_source_representatives.__setitem__((0, 0), np.nan), "non-finite"),
        (lambda s: setattr(s, "optimized_source_representatives", s.optimized_source_representatives.astype("float64")), "dtype"),
    ],
)
def test_save_rejects_malformed_arrays(tmp_path: Path, mutate, match):
    _, cache_path, cache, summary = _fixture(tmp_path)
    mutate(summary)
    with pytest.raises(ValueError, match=match):
        save_candidate_summary(summary, cache_path, cache_metadata=cache.metadata)


def test_missing_or_modified_params_and_source_crc_are_misses(tmp_path: Path):
    _, cache_path, cache, summary = _fixture(tmp_path)
    sidecar = save_candidate_summary(summary, cache_path, cache_metadata=cache.metadata)
    with np.load(sidecar, allow_pickle=False) as raw:
        metadata = raw["metadata"].item()
        arrays = {name: np.array(raw[name], copy=True) for name in raw.files if name != "metadata"}
    import json

    payload = json.loads(metadata)
    payload["summary_params"]["window_seconds"] = 31.0
    np.savez_compressed(sidecar, metadata=np.asarray(json.dumps(payload), dtype=np.str_), **arrays)
    with pytest.raises(ValueError, match="parameters"):
        load_candidate_summary(sidecar, expected_cache_metadata=cache.metadata, source_cache_path=cache_path)

    save_candidate_summary(summary, cache_path, cache_metadata=cache.metadata)
    cache_path.write_bytes(cache_path.read_bytes().replace(b"frame_features", b"frame_featurex"))
    with pytest.raises(ValueError):
        load_candidate_summary(sidecar, expected_cache_metadata=cache.metadata, source_cache_path=cache_path)
    assert cache_path.exists()


def test_hot_sidecar_hit_does_not_load_full_cache(monkeypatch, tmp_path: Path):
    _, cache_path, cache, summary = _fixture(tmp_path)
    sidecar = save_candidate_summary(summary, cache_path, cache_metadata=cache.metadata)

    def forbidden(*args, **kwargs):
        raise AssertionError("full frame cache load on sidecar hit")

    monkeypatch.setattr(FrameEmbeddingCache, "load_valid", forbidden)
    loaded = load_candidate_summary(
        sidecar,
        expected_cache_metadata=cache.metadata,
        source_cache_path=cache_path,
    )
    assert loaded.frame_count == cache.embeddings.shape[0]


def test_loaded_summary_matches_full_selector_for_optimized_and_baseline(tmp_path: Path):
    # Five distinct videos force the selector through its FAISS coarse search
    # branch when candidate_limit=1; the two-video shortcut would only compare
    # the trivial all-pairs result and could hide sketch mismatches.
    full = {}
    compact = {}
    for index in range(5):
        video, cache_path, cache, summary = _fixture(tmp_path / f"video-{index}", count=80)
        save_candidate_summary(summary, cache_path, cache_metadata=cache.metadata)
        loaded = load_candidate_summary(
            cache_path,
            expected_cache_metadata=cache.metadata,
            source_cache_path=cache_path,
        )
        full[video] = cache
        compact[video] = loaded

    assert len(full) == 5
    for mode in ("optimized", "baseline"):
        full_selection = select_candidate_pairs(full, 1, 0.8, sketch_mode=mode)
        compact_selection = select_candidate_pairs(compact, 1, 0.8, sketch_mode=mode)
        assert full_selection.pairs == compact_selection.pairs


@pytest.mark.parametrize("field", ["embedding_model", "embedding_runtime", "preprocess_config", "skip_threshold", "max_gap_sec", "frame_step"])
def test_cache_profile_identity_changes_invalidate_summary(tmp_path: Path, field):
    _, cache_path, cache, summary = _fixture(tmp_path)
    save_candidate_summary(summary, cache_path, cache_metadata=cache.metadata)
    expected = dict(cache.metadata)
    if field == "preprocess_config":
        expected[field] = dict(expected[field])
        expected[field]["input_size"] = int(expected[field]["input_size"]) + 1
    elif field in {"skip_threshold", "max_gap_sec"}:
        expected[field] = float(expected[field]) + 1.0
    elif field == "frame_step":
        expected[field] = int(expected[field]) + 1
    else:
        expected[field] = str(expected[field]) + "-changed"
    with pytest.raises(ValueError, match="metadata"):
        load_candidate_summary(cache_path, expected_cache_metadata=expected, source_cache_path=cache_path)


def test_same_size_mtime_rewrite_changes_zip_crc_identity(tmp_path: Path):
    _, cache_path, cache, summary = _fixture(tmp_path)
    save_candidate_summary(summary, cache_path, cache_metadata=cache.metadata)
    fixed = 1_700_000_000_000_000_000
    cache_path.touch()
    import os

    os.utime(cache_path, ns=(fixed, fixed))
    before = artifact_identity(cache_path)
    cache.embeddings[0, 0] *= -1.0
    cache.save(cache_path)
    os.utime(cache_path, ns=(fixed, fixed))
    after = artifact_identity(cache_path)
    assert before["content_identity"] == after["content_identity"] == "zip_manifest"
    assert before["content_digest"] != after["content_digest"]
    with pytest.raises(ValueError, match="identity|artifact"):
        load_candidate_summary(cache_path, expected_cache_metadata=cache.metadata, source_cache_path=cache_path)


def test_failed_summary_save_does_not_count_rebuild(monkeypatch, tmp_path: Path):
    from scripts import batch_compare
    from video_sim import candidate_summary_store
    from video_sim.metrics import RecognitionMetrics

    _, cache_path, cache, _ = _fixture(tmp_path)
    monkeypatch.setattr(candidate_summary_store, "save_candidate_summary", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    metrics = RecognitionMetrics()
    _, saved = batch_compare.build_and_save_candidate_summary(cache, cache_path, metrics)
    assert saved is False
    assert metrics.counters.get("candidate_summary_rebuilds", 0) == 0
    assert metrics.counters.get("candidate_summary_load_errors", 0) == 1


def test_corrupt_sidecars_are_rejected_without_touching_frame_cache(tmp_path: Path):
    _, cache_path, cache, summary = _fixture(tmp_path)
    sidecar = save_candidate_summary(summary, cache_path, cache_metadata=cache.metadata)
    original = sidecar.read_bytes()
    import json

    with np.load(sidecar, allow_pickle=False) as raw:
        arrays = {name: np.array(raw[name], copy=True) for name in raw.files}
    payload = json.loads(arrays["metadata"].item())
    payload["summary_schema_version"] = SUMMARY_SCHEMA_VERSION + 1
    arrays["metadata"] = np.asarray(json.dumps(payload), dtype=np.str_)
    np.savez_compressed(sidecar, **arrays)
    with pytest.raises(ValueError, match="schema"):
        load_candidate_summary(sidecar, expected_cache_metadata=cache.metadata, source_cache_path=cache_path)

    sidecar.write_bytes(original)
    with np.load(sidecar, allow_pickle=False) as raw:
        arrays = {name: np.array(raw[name], copy=True) for name in raw.files}
    arrays["optimized_index_embeddings"] = arrays["optimized_index_embeddings"][:, :1]
    np.savez_compressed(sidecar, **arrays)
    with pytest.raises(ValueError, match="dimension|shape"):
        load_candidate_summary(sidecar, expected_cache_metadata=cache.metadata, source_cache_path=cache_path)

    sidecar.write_bytes(original)
    with np.load(sidecar, allow_pickle=False) as raw:
        arrays = {name: np.array(raw[name], copy=True) for name in raw.files}
    arrays["auxiliary_signatures"] = arrays["auxiliary_signatures"].astype(object)
    np.savez_compressed(sidecar, **arrays)
    with pytest.raises(ValueError, match="pickle|object"):
        load_candidate_summary(sidecar, expected_cache_metadata=cache.metadata, source_cache_path=cache_path)

    sidecar.write_bytes(original[: max(1, len(original) // 2)])
    with pytest.raises(Exception):
        load_candidate_summary(sidecar, expected_cache_metadata=cache.metadata, source_cache_path=cache_path)
    assert cache_path.exists()


@pytest.mark.parametrize("archive_builder,match", [
    (
        lambda archive: archive.writestr("metadata.npy", b"x" * (1024 * 1024 + 1)),
        "oversized",
    ),
    (
        lambda archive: archive.writestr("unexpected.npy", b"x"),
        "unknown",
    ),
])
def test_sidecar_zip_preflight_rejects_oversized_or_unknown_members(
    tmp_path: Path, archive_builder, match
):
    _, cache_path, cache, _ = _fixture(tmp_path)
    sidecar = candidate_summary_path(cache_path)
    with zipfile.ZipFile(sidecar, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive_builder(archive)
    with pytest.raises(ValueError, match=match):
        load_candidate_summary(
            sidecar,
            expected_cache_metadata=cache.metadata,
            source_cache_path=cache_path,
        )


def test_sidecar_zip_preflight_rejects_duplicate_members(tmp_path: Path):
    _, cache_path, cache, _ = _fixture(tmp_path)
    sidecar = candidate_summary_path(cache_path)
    with zipfile.ZipFile(sidecar, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("metadata.npy", b"x")
        archive.writestr("metadata.npy", b"y")
    with pytest.raises(ValueError, match="duplicate"):
        load_candidate_summary(
            sidecar,
            expected_cache_metadata=cache.metadata,
            source_cache_path=cache_path,
        )
