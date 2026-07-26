import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_package_import_does_not_load_video_dependencies() -> None:
    script = (
        "import sys, video_sim; "
        "assert video_sim.__version__; "
        "assert 'cv2' not in sys.modules; "
        "assert 'decord' not in sys.modules"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
