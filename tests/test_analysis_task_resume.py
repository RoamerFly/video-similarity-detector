import json
from pathlib import Path

from scripts import batch_compare


def test_task_manifest_persists_resume_progress(tmp_path: Path):
    video_a = tmp_path / "a.mp4"
    video_b = tmp_path / "b.mp4"
    video_a.write_bytes(b"a")
    video_b.write_bytes(b"bb")
    state_path = batch_compare.task_state_path(tmp_path, "analysis-test")
    manifest_path = state_path.parent / "task.json"

    batch_compare.start_task_manifest(
        manifest_path=manifest_path,
        task_id="analysis-test",
        input_dir=tmp_path,
        videos=[video_a, video_b],
        total_pairs=4,
        completed_pairs=1,
        match_key="same-config",
        config={"videoDir": str(tmp_path)},
        output_base=tmp_path / "reports" / "result",
    )
    batch_compare.update_task_manifest(
        status="paused",
        completedPairs=2,
        progress=50.0,
        stage="任务已暂停",
    )

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["id"] == "analysis-test"
    assert manifest["status"] == "paused"
    assert manifest["completedPairs"] == 2
    assert manifest["progress"] == 50.0
    assert manifest["matchKey"] == "same-config"
    assert [video["path"] for video in manifest["videos"]] == [
        str(video_a.resolve()),
        str(video_b.resolve()),
    ]


def test_task_state_path_sanitizes_external_id(tmp_path: Path):
    state_path = batch_compare.task_state_path(tmp_path, "../unsafe task")

    assert state_path.parent.parent == tmp_path / "cache" / "tasks"
    assert state_path.parent.name == "unsafetask"


def test_pair_key_keeps_incremental_pairs_but_invalidates_changed_video(tmp_path: Path):
    video_a = tmp_path / "a.mp4"
    video_b = tmp_path / "b.mp4"
    video_a.write_bytes(b"a")
    video_b.write_bytes(b"b")

    original_key = batch_compare.pair_key(video_a, video_b)
    video_b.write_bytes(b"changed")

    assert batch_compare.pair_key(video_a, video_b) != original_key


def test_stage_progress_and_redo_reset_downstream(tmp_path: Path):
    manifest_path = batch_compare.task_state_path(tmp_path, "analysis-stage").parent / "task.json"
    batch_compare.ACTIVE_TASK_MANIFEST_PATH = manifest_path
    batch_compare.ACTIVE_TASK_MANIFEST = {
        "id": "analysis-stage",
        "status": "running",
        "stages": batch_compare.default_task_stages(),
    }

    batch_compare.update_task_stage("scan", "completed", 100, "扫描完成")
    batch_compare.update_task_stage("cache", "completed", 100, "缓存检查完成")
    batch_compare.update_task_stage("features", "completed", 100, "特征完成")

    assert batch_compare.task_stage_is_completed("scan")
    assert batch_compare.task_stage_is_completed("features")
    assert not batch_compare.task_stage_is_completed("candidate")
    assert batch_compare.ACTIVE_TASK_MANIFEST["progress"] == 55.0
    batch_compare.validate_stage_prerequisites("candidate")

    batch_compare.reset_task_stage_and_downstream("features")
    stages = {
        stage["id"]: stage
        for stage in batch_compare.ACTIVE_TASK_MANIFEST["stages"]
    }
    assert stages["scan"]["status"] == "completed"
    assert stages["cache"]["status"] == "completed"
    assert stages["features"]["status"] == "pending"
    assert stages["candidate"]["status"] == "pending"
    assert batch_compare.ACTIVE_TASK_MANIFEST["progress"] == 20.0
