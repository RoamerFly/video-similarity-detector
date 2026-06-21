"""Locate an optional application-local CLIP model for offline use."""

import os
from pathlib import Path
from typing import Optional, Union


DEFAULT_EMBEDDING_MODEL = "openai/clip-vit-base-patch32"
LOCAL_EMBEDDING_MODEL_DIR = "clip-vit-base-patch32"


def _is_complete_local_model(path: Path) -> bool:
    if not path.is_dir():
        return False
    if not (path / "config.json").is_file():
        return False
    if not (path / "preprocessor_config.json").is_file():
        return False
    return any(
        (path / name).is_file()
        for name in (
            "model.safetensors",
            "model.safetensors.index.json",
            "pytorch_model.bin",
            "pytorch_model.bin.index.json",
        )
    )


def _resolve_cached_snapshot(cache_root: Path) -> Optional[Path]:
    snapshots = cache_root / "snapshots"
    if not snapshots.is_dir():
        return None

    refs_main = cache_root / "refs" / "main"
    if refs_main.is_file():
        try:
            revision = refs_main.read_text(encoding="utf-8").strip()
        except OSError:
            revision = ""
        if revision:
            candidate = snapshots / revision
            if _is_complete_local_model(candidate):
                return candidate

    candidates = sorted(
        (path for path in snapshots.iterdir() if _is_complete_local_model(path)),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def resolve_embedding_model_source(
    project_root: Optional[Union[str, Path]] = None,
) -> Union[str, Path]:
    """
    Prefer an offline model next to the application, then use Hugging Face.

    Supported layouts:
      models/clip-vit-base-patch32/
      models/models--openai--clip-vit-base-patch32/{blobs,refs,snapshots}/
    """
    override = os.environ.get("VIDEO_SIM_CLIP_MODEL_DIR", "").strip()
    roots = []
    if override:
        roots.append(Path(override).expanduser())
    if project_root is not None:
        roots.append(Path(project_root).expanduser() / "models")

    module_root = Path(__file__).resolve().parent.parent
    roots.extend([Path.cwd() / "models", module_root / "models"])

    seen = set()
    for root in roots:
        resolved_root = root.resolve(strict=False)
        key = os.path.normcase(str(resolved_root))
        if key in seen:
            continue
        seen.add(key)

        direct_candidates = [resolved_root]
        if resolved_root.name != LOCAL_EMBEDDING_MODEL_DIR:
            direct_candidates.append(resolved_root / LOCAL_EMBEDDING_MODEL_DIR)

        for candidate in direct_candidates:
            if _is_complete_local_model(candidate):
                return candidate

        cache_root = (
            resolved_root
            if resolved_root.name == "models--openai--clip-vit-base-patch32"
            else resolved_root / "models--openai--clip-vit-base-patch32"
        )
        snapshot = _resolve_cached_snapshot(cache_root)
        if snapshot is not None:
            return snapshot

    return DEFAULT_EMBEDDING_MODEL
