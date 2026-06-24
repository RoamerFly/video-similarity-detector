import json
import sys
import types
from pathlib import Path

import numpy as np

from scripts import batch_compare

decord_stub = types.ModuleType("decord")
decord_stub.VideoReader = object
decord_stub.cpu = lambda *_args, **_kwargs: None
sys.modules.setdefault("decord", decord_stub)

from video_sim.embedder import FrameEmbeddingCache
from video_sim.preprocess import PreprocessConfig


def _save_minimal_cache(
    video_path: Path,
    cache_dir: Path,
    config: PreprocessConfig,
    *,
    skip_threshold: float = 0.4,
    max_gap_sec: float = 45.0,
    frame_step: int = 30,
) -> Path:
    cache_path = FrameEmbeddingCache.get_cache_path(
        video_path,
        cache_dir,
        config,
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
    )
    metadata = FrameEmbeddingCache.build_metadata(
        video_path,
        skip_threshold=skip_threshold,
        max_gap_sec=max_gap_sec,
        frame_step=frame_step,
        preprocess_config=config,
    )
    cache = FrameEmbeddingCache(
        video_path=str(video_path.resolve()),
        frame_indices=np.array([0], dtype=np.int64),
        timestamps=np.array([0.0], dtype=np.float32),
        phashes=["phash"],
        thumbnail_paths=[],
        embeddings=np.array([[1.0, 0.0]], dtype=np.float32),
        preprocess_config=config,
        metadata=metadata,
    )
    cache.save(cache_path)
    return cache_path


def test_frame_cache_profiles_use_short_numbered_directories(tmp_path: Path):
    video = tmp_path / "sample.mp4"
    video.write_bytes(b"video")
    cache_dir = tmp_path / "data"

    first_config = PreprocessConfig(input_size=128)
    first_path = _save_minimal_cache(video, cache_dir, first_config)

    assert first_path.parent.name == "1"
    assert first_path.name == "frame_features.npz"

    profile = json.loads((first_path.parent / "profile.json").read_text(encoding="utf-8"))
    assert profile["directory"] == "1"
    assert profile["cache_file"] == "frame_features.npz"
    assert profile["preprocess_config"]["input_size"] == 128
    assert profile["skip_threshold"] == 0.4
    assert profile["max_gap_sec"] == 45.0
    assert profile["frame_step"] == 30
    assert profile["profile_key"]

    same_path = FrameEmbeddingCache.get_cache_path(
        video,
        cache_dir,
        first_config,
        skip_threshold=0.4,
        max_gap_sec=45.0,
        frame_step=30,
    )
    assert same_path == first_path

    second_path = FrameEmbeddingCache.get_cache_path(
        video,
        cache_dir,
        PreprocessConfig(input_size=256),
        skip_threshold=0.4,
        max_gap_sec=45.0,
        frame_step=30,
    )
    assert second_path.parent.name == "2"


def test_task_cache_artifacts_are_cache_dir_relative_and_deduped(tmp_path: Path):
    cache_dir = tmp_path / "data"
    manifest_path = batch_compare.task_state_path(cache_dir, "analysis-test").parent / "task.json"
    video_a = tmp_path / "a.mp4"
    video_b = tmp_path / "b.mp4"
    video_a.write_bytes(b"a")
    video_b.write_bytes(b"b")

    batch_compare.start_task_manifest(
        manifest_path=manifest_path,
        task_id="analysis-test",
        input_dir=tmp_path,
        videos=[video_a, video_b],
        total_pairs=1,
        completed_pairs=0,
        match_key="same-config",
        config={"cacheDir": str(cache_dir)},
        output_base=tmp_path / "reports" / "result",
    )

    artifact = cache_dir / "video_cache" / "sample_abcd" / "1" / "frame_features.npz"
    batch_compare.record_task_cache_artifact(artifact, "first")
    batch_compare.record_task_cache_artifact(Path(str(artifact).replace("/", "\\")), "duplicate")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    artifacts = manifest["cacheArtifacts"]
    assert len(artifacts) == 1
    assert artifacts[0]["pathBase"] == "cacheDir"
    assert artifacts[0]["path"] == "video_cache/sample_abcd/1/frame_features.npz"
