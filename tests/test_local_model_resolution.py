import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "video_sim" / "model_locator.py"
SPEC = importlib.util.spec_from_file_location("video_sim_model_locator_test", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODEL_LOCATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODEL_LOCATOR)
DEFAULT_EMBEDDING_MODEL = MODEL_LOCATOR.DEFAULT_EMBEDDING_MODEL
resolve_embedding_model_source = MODEL_LOCATOR.resolve_embedding_model_source


def write_model_snapshot(path: Path) -> None:
    path.mkdir(parents=True)
    (path / "config.json").write_text("{}", encoding="utf-8")
    (path / "preprocessor_config.json").write_text("{}", encoding="utf-8")
    (path / "model.safetensors").write_bytes(b"model")


def test_prefers_flat_model_next_to_application(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("VIDEO_SIM_CLIP_MODEL_DIR", raising=False)
    model_dir = tmp_path / "models" / "clip-vit-base-patch32"
    write_model_snapshot(model_dir)

    assert resolve_embedding_model_source(tmp_path) == model_dir


def test_resolves_hugging_face_cache_layout(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("VIDEO_SIM_CLIP_MODEL_DIR", raising=False)
    cache_root = tmp_path / "models" / "models--openai--clip-vit-base-patch32"
    snapshot = cache_root / "snapshots" / "revision-123"
    write_model_snapshot(snapshot)
    (cache_root / "refs").mkdir()
    (cache_root / "refs" / "main").write_text("revision-123", encoding="utf-8")

    assert resolve_embedding_model_source(tmp_path) == snapshot


def test_incomplete_local_model_falls_back_to_hugging_face(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("VIDEO_SIM_CLIP_MODEL_DIR", raising=False)
    incomplete = tmp_path / "models" / "clip-vit-base-patch32"
    incomplete.mkdir(parents=True)
    (incomplete / "config.json").write_text("{}", encoding="utf-8")

    assert resolve_embedding_model_source(tmp_path) == DEFAULT_EMBEDDING_MODEL
