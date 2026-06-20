#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./build-linux.sh [options]

Options:
  --skip-python-env          Reuse env/python without installing dependencies.
  --clean-python-env         Recreate env/python from scratch.
  --skip-npm-install         Skip npm ci/npm install.
  --skip-npm-audit           Skip npm audit --audit-level=high.
  --skip-frontend-build      Skip npm run build.
  --skip-tauri-build         Skip Tauri build and reuse existing release artifacts.
  --no-prune-python-env      Keep Python caches/tests in env/python.
  --no-stop-running-app      Fail instead of stopping an old packaged app in dist_linux.
  --python PATH              Host Python used to create env/python.
  --runtime-requirements PATH
  --torch-index-url URL      Optional PyTorch wheel index.
EOF
}

PLATFORM="linux"
DIST_NAME="dist_linux"
SKIP_PYTHON_ENV=0
CLEAN_PYTHON_ENV=0
SKIP_NPM_INSTALL=0
SKIP_NPM_AUDIT=0
SKIP_FRONTEND_BUILD=0
SKIP_TAURI_BUILD=0
NO_PRUNE_PYTHON_ENV=0
NO_STOP_RUNNING_APP=0
HOST_PYTHON="${PYTHON:-}"
RUNTIME_REQUIREMENTS=""
TORCH_INDEX_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-python-env) SKIP_PYTHON_ENV=1; shift ;;
    --clean-python-env) CLEAN_PYTHON_ENV=1; shift ;;
    --skip-npm-install) SKIP_NPM_INSTALL=1; shift ;;
    --skip-npm-audit) SKIP_NPM_AUDIT=1; shift ;;
    --skip-frontend-build) SKIP_FRONTEND_BUILD=1; shift ;;
    --skip-tauri-build) SKIP_TAURI_BUILD=1; shift ;;
    --no-prune-python-env) NO_PRUNE_PYTHON_ENV=1; shift ;;
    --no-stop-running-app) NO_STOP_RUNNING_APP=1; shift ;;
    --python) HOST_PYTHON="${2:-}"; shift 2 ;;
    --runtime-requirements) RUNTIME_REQUIREMENTS="${2:-}"; shift 2 ;;
    --torch-index-url) TORCH_INDEX_URL="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[ERROR] Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$SCRIPT_DIR"
REPO_ROOT="$(cd "$DESKTOP_DIR/.." && pwd)"
DIST_DIR="$DESKTOP_DIR/$DIST_NAME"
ENV_DIR="$DESKTOP_DIR/env"
PYTHON_ENV_DIR="$ENV_DIR/python"
VENV_PYTHON="$PYTHON_ENV_DIR/bin/python"
RELEASE_DIR="$DESKTOP_DIR/src-tauri/target/release"
APP_BINARY="$RELEASE_DIR/video-similarity-desktop"
REQUIREMENTS="$REPO_ROOT/requirements.txt"
DEFAULT_RUNTIME_REQUIREMENTS="$DESKTOP_DIR/requirements-runtime.txt"
RUNTIME_REQUIREMENTS="${RUNTIME_REQUIREMENTS:-$DEFAULT_RUNTIME_REQUIREMENTS}"
[[ -f "$RUNTIME_REQUIREMENTS" ]] || RUNTIME_REQUIREMENTS="$REQUIREMENTS"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[ERROR] Linux builds must be run on Linux." >&2
  exit 1
fi

step() {
  echo
  echo "$1"
}

load_build_tool_paths() {
  if [[ -n "${CARGO_HOME:-}" && -d "$CARGO_HOME/bin" ]]; then
    PATH="$CARGO_HOME/bin:$PATH"
  fi
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck source=/dev/null
    . "$HOME/.cargo/env"
  elif [[ -d "$HOME/.cargo/bin" ]]; then
    PATH="$HOME/.cargo/bin:$PATH"
  fi
  for dir in /usr/local/bin /opt/homebrew/bin; do
    [[ -d "$dir" ]] && PATH="$dir:$PATH"
  done
  export PATH
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[ERROR] Missing required command: $1" >&2
    case "$1" in
      rustc|cargo)
        echo "        Install Rust with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2
        echo "        Then reopen the terminal, or run: source \"\$HOME/.cargo/env\"" >&2
        ;;
      node|npm)
        echo "        Install Node.js LTS from your package manager or https://nodejs.org/." >&2
        ;;
    esac
    exit 1
  fi
}

assert_child_path() {
  local parent child
  parent="$(cd "$1" && pwd)"
  child="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
  case "$child" in
    "$parent"|"$parent"/*) ;;
    *) echo "[ERROR] Refusing to operate outside workspace: $child" >&2; exit 1 ;;
  esac
}

read_requirements() {
  "$HOST_PYTHON" - "$1" <<'PY'
import pathlib
import sys
for raw in pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if line and not line.startswith("#"):
        print(line)
PY
}

install_runtime_requirements() {
  local torch_reqs=()
  local other_reqs=()
  local req

  while IFS= read -r req; do
    if [[ "$req" =~ ^torch([\<\>\=\!\~].*)?$ ]]; then
      torch_reqs+=("$req")
    else
      other_reqs+=("$req")
    fi
  done < <(read_requirements "$RUNTIME_REQUIREMENTS")

  if [[ ${#torch_reqs[@]} -gt 0 ]]; then
    if [[ -n "$TORCH_INDEX_URL" ]]; then
      "$VENV_PYTHON" -m pip install --no-cache-dir --index-url "$TORCH_INDEX_URL" "${torch_reqs[@]}"
    else
      "$VENV_PYTHON" -m pip install --no-cache-dir "${torch_reqs[@]}"
    fi
  fi

  if [[ ${#other_reqs[@]} -gt 0 ]]; then
    "$VENV_PYTHON" -m pip install --no-cache-dir "${other_reqs[@]}"
  fi
}

prune_python_env() {
  [[ -d "$PYTHON_ENV_DIR" ]] || return 0
  echo "  - Pruning Python cache and test files"
  find "$PYTHON_ENV_DIR" \( -type d -name "__pycache__" -o -type d -name "test" -o -type d -name "tests" \) -prune -exec rm -rf {} + 2>/dev/null || true
  find "$PYTHON_ENV_DIR" \( -name "*.pyc" -o -name "*.pyo" \) -type f -delete 2>/dev/null || true
}

prune_portable_sources() {
  local root="$1"
  find "$root/scripts" "$root/video_sim" \( -type d -name "__pycache__" \) -prune -exec rm -rf {} + 2>/dev/null || true
  find "$root/scripts" "$root/video_sim" \( -name "*.pyc" -o -name "*.pyo" \) -type f -delete 2>/dev/null || true
}

verify_python_env() {
  local python="$1"
  echo "  - Verifying bundled Python dependencies"
  "$python" - <<'PY'
import importlib.util
missing = [name for name in ["numpy", "torch", "transformers", "PIL", "cv2", "decord", "faiss", "imagehash", "tqdm"] if importlib.util.find_spec(name) is None]
if missing:
    raise SystemExit("Missing modules: " + ", ".join(missing))
import torch
print("Torch:", torch.__version__)
print("Torch CUDA:", torch.version.cuda)
print("CUDA available:", torch.cuda.is_available())
print("Bundled Python env OK")
PY
}

find_running_pids_for_path() {
  local exe="$1"
  local pattern
  pattern="$(printf '%s' "$exe" | sed 's/[][\/.^$*+?{}()|]/\\&/g')"
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f "$pattern" 2>/dev/null | awk -v self="$$" '$1 != self { print $1 }' || true
  fi
}

stop_running_portable_app() {
  local exe="$DIST_DIR/video-similarity-desktop"
  [[ -e "$exe" ]] || return 0

  local pids=()
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(find_running_pids_for_path "$exe" | sort -u)

  [[ ${#pids[@]} -eq 0 ]] && return 0

  if [[ "$NO_STOP_RUNNING_APP" == "1" ]]; then
    echo "[ERROR] Packaged app is still running: ${pids[*]}. Close it first, or rerun without --no-stop-running-app." >&2
    exit 1
  fi

  echo "  - Stopping running packaged app: ${pids[*]}"
  kill "${pids[@]}" 2>/dev/null || true

  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    local alive=0
    for pid in "${pids[@]}"; do
      kill -0 "$pid" 2>/dev/null && alive=1
    done
    [[ "$alive" == "0" ]] && return 0
    sleep 1
  done

  kill -9 "${pids[@]}" 2>/dev/null || true
}

remove_dist_dir() {
  [[ -d "$DIST_DIR" ]] || return 0
  assert_child_path "$DESKTOP_DIR" "$DIST_DIR"
  stop_running_portable_app

  for attempt in 1 2 3 4 5 6 7 8; do
    rm -rf "$DIST_DIR" 2>/dev/null || true
    [[ ! -e "$DIST_DIR" ]] && return 0
    echo "  - Portable output directory is still busy; retrying in $attempt seconds ($attempt/8)."
    sleep "$attempt"
  done

  echo "[ERROR] Failed to remove portable output directory: $DIST_DIR" >&2
  exit 1
}

copy_runtime_tree() {
  remove_dist_dir

  mkdir -p "$DIST_DIR/data/reports" "$DIST_DIR/data/cache" "$DIST_DIR/data/frames"
  cp -R "$REPO_ROOT/scripts" "$DIST_DIR/scripts"
  cp -R "$REPO_ROOT/video_sim" "$DIST_DIR/video_sim"
  prune_portable_sources "$DIST_DIR"
  cp "$REQUIREMENTS" "$DIST_DIR/requirements.txt"
  cp "$RUNTIME_REQUIREMENTS" "$DIST_DIR/requirements-runtime.txt"
  cp -R "$ENV_DIR" "$DIST_DIR/env"
  chmod +x "$DIST_DIR/env/ffmpeg" "$DIST_DIR/env/ffprobe"
}

copy_linux_artifact() {
  if [[ ! -f "$APP_BINARY" ]]; then
    echo "[ERROR] No Linux build artifact found: $APP_BINARY" >&2
    exit 1
  fi

  cp "$APP_BINARY" "$DIST_DIR/video-similarity-desktop"
  chmod +x "$DIST_DIR/video-similarity-desktop"
  find "$RELEASE_DIR/bundle" -type f \( -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" \) -exec cp {} "$DIST_DIR/" \; 2>/dev/null || true

  cat > "$DIST_DIR/run-video-similarity.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export USE_TF=0
export TRANSFORMERS_NO_TF=1
export TF_CPP_MIN_LOG_LEVEL=2
export PYTHONNOUSERSITE=1
export VIDEO_SIM_FFMPEG="$PWD/env/ffmpeg"
export PATH="$PWD/env:$PATH"
./video-similarity-desktop
EOF
  chmod +x "$DIST_DIR/run-video-similarity.sh"
}

write_readme() {
  cat > "$DIST_DIR/README_linux.txt" <<'EOF'
Video Similarity - Linux portable package

Output structure:
- video-similarity-desktop: executable app.
- env/python/: bundled runtime and dependencies.
- env/ffmpeg and env/ffprobe: bundled standalone media tools.
- data/: analysis data, cache and reports.
- scripts/ and video_sim/: analysis engine copied next to the executable.

Run:
  ./run-video-similarity.sh

Keep the in-app Python path as "python" to use env/python automatically.
EOF
}

assert_portable_package() {
  [[ -x "$DIST_DIR/video-similarity-desktop" ]] || { echo "[ERROR] Missing executable"; exit 1; }
  [[ -d "$DIST_DIR/env/python" ]] || { echo "[ERROR] Missing env/python"; exit 1; }
  [[ -x "$DIST_DIR/env/ffmpeg" ]] || { echo "[ERROR] Missing env/ffmpeg"; exit 1; }
  [[ -x "$DIST_DIR/env/ffprobe" ]] || { echo "[ERROR] Missing env/ffprobe"; exit 1; }
  [[ -d "$DIST_DIR/data/reports" ]] || { echo "[ERROR] Missing data/reports"; exit 1; }
  [[ -f "$DIST_DIR/scripts/batch_compare.py" ]] || { echo "[ERROR] Missing scripts/batch_compare.py"; exit 1; }
  [[ -f "$DIST_DIR/scripts/merge_videos.py" ]] || { echo "[ERROR] Missing scripts/merge_videos.py"; exit 1; }
  [[ -f "$DIST_DIR/video_sim/candidate_selector.py" ]] || { echo "[ERROR] Missing video_sim/candidate_selector.py"; exit 1; }
  [[ -f "$DIST_DIR/video_sim/matcher.py" ]] || { echo "[ERROR] Missing video_sim/matcher.py"; exit 1; }
  [[ -x "$DIST_DIR/env/python/bin/python" || -x "$DIST_DIR/env/python/bin/python3" ]] || { echo "[ERROR] Missing env/python/bin/python"; exit 1; }

  local dist_python="$DIST_DIR/env/python/bin/python"
  [[ -x "$dist_python" ]] || dist_python="$DIST_DIR/env/python/bin/python3"
  "$DIST_DIR/env/ffmpeg" -version >/dev/null
  "$DIST_DIR/env/ffprobe" -version >/dev/null
  verify_python_env "$dist_python"
  "$dist_python" -m py_compile \
    "$DIST_DIR/scripts/batch_compare.py" \
    "$DIST_DIR/scripts/merge_videos.py" \
    "$DIST_DIR/video_sim/candidate_selector.py" \
    "$DIST_DIR/video_sim/preprocess.py" \
    "$DIST_DIR/video_sim/frame_sampler.py" \
    "$DIST_DIR/video_sim/matcher.py" \
    "$DIST_DIR/video_sim/reporter.py"
}

echo
echo "========================================"
echo "  Video Similarity - Linux Packager"
echo "========================================"
echo "Project root : $REPO_ROOT"
echo "Desktop dir  : $DESKTOP_DIR"
echo "Output dir   : $DIST_DIR"
echo "Env dir      : $ENV_DIR"
echo "Runtime reqs : $RUNTIME_REQUIREMENTS"

cd "$DESKTOP_DIR"

if [[ ! -x "$ENV_DIR/ffmpeg" || ! -x "$ENV_DIR/ffprobe" ]]; then
  step "[0/9] Downloading standalone FFmpeg runtime..."
  chmod +x "$REPO_ROOT/scripts/prepare-ffmpeg-runtime.sh"
  "$REPO_ROOT/scripts/prepare-ffmpeg-runtime.sh" linux-x64
fi

step "[1/9] Checking build tools..."
load_build_tool_paths
need_cmd node
need_cmd npm
need_cmd rustc
need_cmd cargo
if [[ -z "$HOST_PYTHON" ]]; then
  if command -v python3 >/dev/null 2>&1; then HOST_PYTHON="python3"; else HOST_PYTHON="python"; fi
fi
need_cmd "$HOST_PYTHON"
echo "  - Node.js: $(node --version)"
echo "            $(command -v node)"
echo "  - npm    : $(npm --version)"
echo "            $(command -v npm)"
echo "  - Rust   : $(rustc --version)"
echo "            $(command -v rustc)"
echo "  - Cargo  : $(cargo --version)"
echo "            $(command -v cargo)"
echo "  - Python : $("$HOST_PYTHON" --version)"

step "[2/9] Preparing app icons..."
mkdir -p "$DESKTOP_DIR/src-tauri/icons"
[[ -f "$DESKTOP_DIR/icon.png" ]] && cp "$DESKTOP_DIR/icon.png" "$DESKTOP_DIR/src-tauri/icons/icon.png"
[[ -f "$DESKTOP_DIR/icon.ico" ]] && cp "$DESKTOP_DIR/icon.ico" "$DESKTOP_DIR/src-tauri/icons/icon.ico"
[[ -f "$REPO_ROOT/icon.png" && ! -f "$DESKTOP_DIR/src-tauri/icons/icon.png" ]] && cp "$REPO_ROOT/icon.png" "$DESKTOP_DIR/src-tauri/icons/icon.png"

step "[3/9] Preparing bundled Python env..."
mkdir -p "$ENV_DIR"
if [[ "$CLEAN_PYTHON_ENV" == "1" && -d "$PYTHON_ENV_DIR" ]]; then
  assert_child_path "$DESKTOP_DIR" "$PYTHON_ENV_DIR"
  rm -rf "$PYTHON_ENV_DIR"
fi

if [[ "$SKIP_PYTHON_ENV" == "1" ]]; then
  [[ -x "$VENV_PYTHON" ]] || { echo "[ERROR] --skip-python-env requested, but $VENV_PYTHON was not found."; exit 1; }
  echo "  - Skipped Python env creation by flag."
else
  if [[ ! -x "$VENV_PYTHON" ]]; then
    "$HOST_PYTHON" -m venv --copies "$PYTHON_ENV_DIR"
  else
    echo "  - Existing env found: $PYTHON_ENV_DIR"
  fi
  "$VENV_PYTHON" -m pip install --no-cache-dir --upgrade pip wheel "setuptools<82"
  install_runtime_requirements
  [[ "$NO_PRUNE_PYTHON_ENV" == "1" ]] || prune_python_env
  cat > "$ENV_DIR/ENVIRONMENT.txt" <<EOF
Video Similarity bundled Python env
Created: $(date "+%Y-%m-%d %H:%M:%S")
Python: $("$VENV_PYTHON" --version)
Runtime requirements: $RUNTIME_REQUIREMENTS
Platform: $PLATFORM
EOF
fi
verify_python_env "$VENV_PYTHON"

step "[4/9] Installing frontend dependencies..."
if [[ "$SKIP_NPM_INSTALL" == "1" ]]; then
  echo "  - Skipped npm install by flag."
elif [[ -f "$DESKTOP_DIR/package-lock.json" ]]; then
  npm ci
else
  npm install
fi

if [[ "$SKIP_NPM_AUDIT" == "1" ]]; then
  echo "  - Skipped npm audit by flag."
else
  npm audit --audit-level=high
fi

step "[5/9] Building frontend..."
if [[ "$SKIP_FRONTEND_BUILD" == "1" ]]; then
  echo "  - Skipped frontend build by flag."
else
  npm run build
fi

step "[6/9] Checking Tauri CLI..."
if [[ "$SKIP_TAURI_BUILD" == "1" ]]; then
  echo "  - Skipped Tauri CLI check by flag."
else
  npx tauri --version >/dev/null
fi

step "[7/9] Building Linux app..."
if [[ "$SKIP_TAURI_BUILD" == "1" ]]; then
  echo "  - Skipped Tauri build by flag."
else
  override="$(mktemp)"
  printf '{"build":{"beforeBuildCommand":""}}\n' > "$override"
  npx tauri build --no-bundle --features custom-protocol --config "$override"
  rm -f "$override"
fi

step "[8/9] Creating portable $DIST_NAME package..."
copy_runtime_tree
copy_linux_artifact
write_readme
assert_portable_package

step "[9/9] Summary..."
echo "  - Portable package: $DIST_DIR"
echo "  - Bundled env     : yes"
echo
find "$DIST_DIR" -maxdepth 1 -mindepth 1 -print | sort | sed "s#^#  - #"
echo
echo "Build complete."
