# 跨平台 Runtime Manager

从 v1.1.0 开始，Windows、macOS 和 Linux 的应用本体、安装包、便携包与 updater 资产都不再携带 Python、PyTorch、CUDA 和 FFmpeg。运行环境作为版本化资产独立发布，只在首次启动或 `runtime-version` 变化时下载一次。

- Windows：保存在用户选择的安装目录内，与旧版目录结构兼容。
- macOS：保存在 Application Support。签名 `.app` 不能在安装后写入或被局部保留。
- Linux：保存在用户本地数据目录。AppImage 和系统包的程序目录可能只读。

## 目录结构

```text
<Windows 用户选择的安装目录>/
├─ video-similarity-desktop.exe
├─ scripts/
├─ video_sim/
├─ env/
│  ├─ python/
│  ├─ ffmpeg.exe
│  ├─ ffprobe.exe
│  └─ .runtime.json
├─ models/
│  └─ clip-vit-base-patch32/
└─ data/
   └─ .downloads/
      └─ runtime/
```

macOS/Linux 的可写数据根目录采用相同的 `env/`、`models/` 和 `data/` 子目录。应用优先使用与 `desktop/runtime-version.txt` 和当前构建匹配的 `env`；Windows CPU/GPU 安装在各自的自定义安装目录中，macOS/Linux 使用各自架构的 CPU 环境。

Windows GPU runtime 固定使用 PyTorch 的 CUDA 13.0 构建。下载前会通过 `nvidia-smi` 检查主 GPU：要求 Turing 或更新架构（计算能力 7.5+）以及 R580 或更新驱动。不满足条件时会停止大文件下载并提示改用 CPU 包。

旧版本安装目录中的 `env` 若仍保留在当前可执行文件旁，会被自动识别并立即兼容使用。Windows 设置页的“就地登记”只在现有 `env` 内写入 `.runtime.json`，不会移动或复制大型文件，也不会重新下载。macOS/Linux 若检测到旧包体旁的环境，则迁移到平台可写数据目录。

## 发布资产

发布流程生成以下独立资产：

```text
Video_Similarity-runtime-v<runtime-version>-windows-x64-cpu.zip
Video_Similarity-runtime-v<runtime-version>-windows-x64-cpu.zip.sha256
Video_Similarity-runtime-v<runtime-version>-windows-x64-gpu.zip
Video_Similarity-runtime-v<runtime-version>-windows-x64-gpu.zip.sha256
Video_Similarity-runtime-v<runtime-version>-macos-arm64.zip
Video_Similarity-runtime-v<runtime-version>-macos-arm64.zip.sha256
Video_Similarity-runtime-v<runtime-version>-macos-x64.zip
Video_Similarity-runtime-v<runtime-version>-macos-x64.zip.sha256
Video_Similarity-runtime-v<runtime-version>-linux-x64.zip
Video_Similarity-runtime-v<runtime-version>-linux-x64.zip.sha256
```

压缩包顶层必须包含 `env/`。每个 runtime 都先下载 `.sha256`，再断点续传单个 ZIP；校验通过后才安全解压到安装目录内的临时目录，并原子替换 `env/`。Windows GPU runtime 固定使用 PyTorch 2.9.1+cu130，构建任务会拒绝超过 GitHub 2 GiB 限制的资产。macOS/Linux 解压时会恢复 ZIP 中的 Unix 权限，确保 Python、FFmpeg 和 FFprobe 可执行。

CLIP 模型继续作为独立资产。Windows 模型安装到用户所选目录的 `models/`；macOS/Linux 安装到平台可写数据根目录的 `models/`。模型不会进入应用包或 runtime ZIP。

## 何时递增 runtime version

仅在下列变更需要用户重新下载环境时递增 `desktop/runtime-version.txt`：

- Python 主版本或可执行布局变化；
- PyTorch CPU/CUDA 运行时变化；
- FFmpeg/FFprobe 二进制变化；
- `requirements-runtime.txt` 中影响运行环境的依赖变化。

只修改 React、Rust、Python 业务脚本、样式或文档时，不要递增 runtime version。

## 发布前检查

1. Windows CPU/GPU、macOS arm64/x64 和 Linux x64 的 runtime 都包含可执行的 Python、FFmpeg 和 FFprobe。
2. `.sha256` 的首个字段是对应 ZIP 的 64 位 SHA-256。
3. 三端安装包、便携包和 updater 资产均不包含 `env/`、模型与可变数据目录。
4. `latest.json`、`windows.json`、`darwin.json`、`linux.json` 都指向对应的轻量应用资产。
5. 新安装启动后会出现 runtime 初始化界面；下载支持代理、断点续传和取消。
6. Windows 已安装旧版 `env` 的用户可以继续运行，并能从设置页无下载就地登记。
7. 托管 runtime 安装完成后，Python 环境检查和一次最小分析任务均通过。
8. GPU 包会在下载前拒绝计算能力低于 7.5 或驱动低于 R580 的设备，并给出 CPU 包建议。
9. 每个 GitHub Release 资产严格小于 2 GiB，Windows GPU runtime 的单文件大小和哈希均通过发布任务校验。
