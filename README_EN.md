<p align="center">
  <a href="README.md">简体中文</a> | <a href="README_EN.md">English</a>
</p>

<p align="center">
  <img src="icon.png" alt="Video Similarity Detector" width="128">
</p>

<h1 align="center">Video Similarity Detector</h1>

<p align="center">A local-first desktop app for video similarity, containment, duplicate-file detection, and media cleanup.</p>

<p align="center">
  <a href="https://github.com/RoamerFly/video-similarity-detector/releases"><img src="https://img.shields.io/github/downloads/RoamerFly/video-similarity-detector/total?style=flat-square" alt="Downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-22c55e.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-2563eb" alt="Platform">
  <img src="https://img.shields.io/badge/CUDA-optional-16a34a" alt="CUDA optional">
</p>

<p align="center">
  <a href="#for-users">Users</a> &nbsp;|&nbsp;
  <a href="#download-and-install">Download</a> &nbsp;|&nbsp;
  <a href="#basic-workflow">Workflow</a> &nbsp;|&nbsp;
  <a href="#ui-preview">Preview</a> &nbsp;|&nbsp;
  <a href="#for-developers">Developers</a> &nbsp;|&nbsp;
  <a href="#license">License</a>
</p>

## For Users

### What It Does

- Scans a video folder and finds similar videos, contained segments, partial overlaps, and exact duplicate files.
- Produces JSON, CSV, and HTML reports, with in-app filtering, sorting, review, and cleanup tools.
- Uses dynamic frame sampling, black-border cropping, portrait rotation, unified resizing, CLIP features, and FAISS search.
- Supports task history, resume, stage-based reruns, cache cleanup, damaged-video quarantine, and scan-range filters.
- Includes a multi-track video merge editor with crop, rotate, split, drag-and-drop, audio, and export.
- Keeps videos, caches, and reports local by default.

### Download And Install

Open [GitHub Releases](https://github.com/RoamerFly/video-similarity-detector/releases) and download only the application package for your system:

- Windows: use `windows-x64-cpu-installer.exe` for most PCs. Use `windows-x64-gpu-installer.exe` only for NVIDIA Turing-or-newer GPUs (compute capability 7.5+) with R580+ drivers.
- macOS: use the `macos-arm64-installer.dmg` for Apple Silicon or the `macos-x64-installer.dmg` for Intel Macs.
- Linux: download `.deb`, `.rpm`, or the portable `.tar.gz`.
- To run without installing, choose the matching package whose name contains `portable`, extract it, and start the app.

Starting with v1.1.0, the application and AI runtime are distributed separately. The installer or portable package is lightweight. On first launch, the app installs the matching Python, PyTorch, and FFmpeg runtime once. CPU runtimes are generally a few hundred MB; the Windows GPU runtime is close to 2 GiB.

On Windows, the executable, `scripts`, `video_sim`, `env`, `models`, and `data` all stay under the custom folder selected in the installer. Overwrite updates replace only the application and business-code files, preserving the large `env`, `models`, and `data` directories.

Later button, merge-editor, UI, or business-logic updates only download a tens-of-MB application update and reuse the installed runtime and model. A runtime is downloaded again only when its own version changes. If a v1.0.x `env` still exists beside the app, the new version detects and uses it automatically; Settings can register it in place without moving or downloading it.

Files beginning with `Video_Similarity-runtime-`, plus `.sha256`, `*-updater`, `.sig`, and updater JSON files, are selected and verified automatically. Most users should not download them manually. The Windows installer still supports custom paths, overwrite upgrades, and preserving user data and settings during uninstall.

### Offline Model

AI similarity analysis uses `openai/clip-vit-base-patch32`. The model is stored separately from the app and runtime; the app downloads about 600 MB on first use and reuses it for later small updates. For offline use, download this asset from Releases:

```text
clip-vit-base-patch32.zip
```

Extract it next to the app:

```text
App folder/
└─ models/
   └─ clip-vit-base-patch32/
      ├─ config.json
      ├─ preprocessor_config.json
      └─ pytorch_model.bin
```

Lookup order: app-local `models/`, user Hugging Face cache, then online download. In-app overwrite updates do not remove `models/`.

### Basic Workflow

1. Open Settings and confirm the video folder, cache folder, report folder, and CPU/GPU environment.
2. Optionally configure Video Scan Range by size, name, duration, resolution, FPS, or extension.
3. Open Analysis Tasks, scan videos, and create a task.
4. Start, pause, resume, or rerun stages from History.
5. Review similar relations, matched segments, and algorithm frames in Results and Compare View.
6. To organize files, right-click or multi-select videos to move, delete, or reveal them in the file manager.

### UI Preview

The images below are captured from the real desktop app.

#### Analysis Tasks

![Analysis Tasks](docs/screenshots-en/analyze.png)

#### Results Overview

![Results Overview](docs/screenshots-en/results.png)

#### Compare View

![Compare View](docs/screenshots-en/compare.png)

#### Multi-track Merge Editor

![Multi-track Merge Editor](docs/screenshots-en/merge.png)

#### Settings

![Settings](docs/screenshots-en/settings.png)

### Supported Formats

Videos: `mp4, mkv, avi, mov, webm, flv, wmv`

Audio: `mp3, wav, flac, aac, m4a, ogg, opus, wma`

Playback support also depends on the system WebView2 and the actual codec. When preview playback fails, frame previews can still help with review.

### Privacy And Safety

- Videos are processed locally by default and are not uploaded by the app.
- Deleting source videos is irreversible; the app asks for confirmation first.
- Similarity results may be wrong and should not be the sole basis for copyright, legal, or enforcement decisions.

## For Developers

### Requirements

- Node.js / npm
- Rust and Cargo
- Python 3.10+
- Optional CUDA / NVIDIA driver for Windows GPU builds

Install frontend dependencies:

```powershell
cd desktop
npm install
```

Install Python dependencies:

```powershell
python -m pip install -r requirements.txt
```

### Common Commands

```powershell
# Frontend dev server
cd desktop
npm run dev

# Tauri dev app
npm run tauri:dev

# Frontend build
npm run build

# Rust check and tests
cd src-tauri
cargo check
cargo test

# Python syntax check example
cd ../..
python -m py_compile scripts/batch_compare.py
```

### Packaging

```powershell
cd desktop

# Windows CPU
.\build-windows.bat

# Windows GPU
.\build-windows-gpu.bat

# Linux
bash ./build-linux.sh

# macOS
bash ./build-macos.sh
```

Outputs are usually written to `desktop/dist_windows*`, `desktop/dist_linux`, and `desktop/dist_macos`.

### Project Layout

```text
video-containment-detector/
├─ desktop/          # Tauri + React desktop app
├─ scripts/          # Python command entry points
├─ video_sim/        # Sampling, preprocessing, embeddings, matching, reports
├─ tests/            # Python tests
├─ docs/screenshots/ # UI screenshots
├─ README_RECO.md    # Recognition logic notes
├─ README_SET.md     # Settings and parameter notes
└─ requirements.txt
```

### Related Docs

- [Recognition logic](README_RECO.md)
- [Settings and parameters](README_SET.md)
- [License](LICENSE)

## Credits

This project uses [Tauri](https://tauri.app/), [React](https://react.dev/), [Vite](https://vite.dev/), [Rust](https://www.rust-lang.org/), [Python](https://www.python.org/), [PyTorch](https://pytorch.org/), [Transformers](https://huggingface.co/docs/transformers/index), [OpenAI CLIP](https://github.com/openai/CLIP), [FAISS](https://github.com/facebookresearch/faiss), [OpenCV](https://opencv.org/), [Decord](https://github.com/dmlc/decord), [FFmpeg](https://ffmpeg.org/), [Radix UI](https://www.radix-ui.com/), [Lucide](https://lucide.dev/), [Zustand](https://zustand-demo.pmnd.rs/), [Playwright](https://playwright.dev/), and other open-source projects. The core idea and early implementation were inspired by [DewduSendanayake/Video-Similarity-Search](https://github.com/DewduSendanayake/Video-Similarity-Search.git).

## License

This project is released under the [MIT License](LICENSE). Third-party dependencies, models, and media content remain under their own licenses.

## Disclaimer

This project is intended for local video similarity analysis, duplicate-content detection, and media organization. Results may contain false positives or false negatives and should not be used as the sole basis for copyright, legal, or platform-enforcement decisions. Users are responsible for ensuring they have the legal right to process the relevant media and for complying with applicable laws, platform rules, and third-party licenses.
