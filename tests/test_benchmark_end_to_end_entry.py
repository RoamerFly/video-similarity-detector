"""Fast entry-point checks for the real recognition benchmark.

The actual CLIP integration run is intentionally not part of the default
pytest suite: it requires a local checkpoint and, for CUDA coverage, a GPU.
These checks ensure the entry point fails or skips clearly without attempting
to download either models or dependencies.
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys

import pytest

from scripts import benchmark_end_to_end as e2e


def test_resolve_python_reports_missing_runtime(tmp_path: Path) -> None:
    missing = tmp_path / "missing-python.exe"
    with pytest.raises(RuntimeError, match=r"Pass --python"):
        e2e._resolve_python(missing)


def test_worker_skips_without_local_model_and_does_not_download(tmp_path: Path) -> None:
    missing_model = tmp_path / "missing-model"
    cache_dir = tmp_path / "cache"
    completed = subprocess.run(
        [
            sys.executable,
            str(Path(e2e.__file__).resolve()),
            "--worker",
            "--device",
            "cpu",
            "--model-dir",
            str(missing_model),
            "--fixtures",
            str(tmp_path / "fixtures"),
            "--cache-dir",
            str(cache_dir),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result["status"] == "skipped"
    assert "not found" in result["skip_reason"]
    assert not cache_dir.exists()
