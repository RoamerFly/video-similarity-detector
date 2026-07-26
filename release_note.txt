## v1.1.0 新版本内容

本版本重点解决应用小更新仍需重复下载大型 AI 环境的问题，并提升首次安装、旧版迁移和海量视频分析的稳定性。

### 新增与优化

- Windows、macOS 和 Linux 的应用本体与 Python、PyTorch、FFmpeg 运行环境已完全分离。安装包、便携包和日常应用更新不再内置大型 AI 环境与模型。
- Windows 的 `env`、`models` 和 `data` 均保存在用户选择的安装目录内；覆盖更新只替换主程序与业务代码，不改动这些目录。
- 首次启动时，应用会自动安装与当前系统、架构和 CPU/GPU 模式匹配的运行环境，并支持代理、断点续传、取消、失败重试、SHA-256 校验和安全替换。
- 以后若只更新界面、按钮、合并编辑功能或业务逻辑，通常只需下载十几至几十 MB 的应用更新，已安装的运行环境和模型会继续复用。
- v1.0.x 用户若程序旁仍保留旧 `env`，新版本会自动识别并继续使用；可在“设置”中就地登记，无需移动、复制或重新下载。
- 优化大型视频库分析时的内存占用，减少候选视频较多时发生卡顿或内存不足的风险。
- 完善合并编辑器的英文界面，提升中英文界面的一致性。

### 修复的问题

- 修复部分旧任务恢复后的匹配异常，并让失败任务统计更加准确。
- 修复旧版帧缓存可能无法安全读取的问题；旧缓存会自动失效并重新生成。
- 增强离线 CLIP 模型的完整性校验，下载或安装文件损坏时会阻止继续使用。
- 修复 macOS/Linux 运行环境安装后部分程序可能无法执行的问题。
- 修复 Intel Mac 运行环境安装失败的问题。
- 修复 Windows GPU 版启动时长时间显示白页、界面卡顿以及黑色命令窗口闪现的问题。
- 修复 Windows 安装包被 Microsoft Defender 错误识别为威胁的问题，改用标准 Windows 安装流程。

## 下载建议

普通用户只需要下载一个与系统对应的应用包：

- Windows CPU 安装版（推荐大多数用户）：`Video_Similarity-v1.1.0-windows-x64-cpu-installer.exe`
- Windows GPU 安装版：`Video_Similarity-v1.1.0-windows-x64-gpu-installer.exe`
- macOS M 系列：`Video_Similarity-v1.1.0-macos-arm64-installer.dmg`
- macOS Intel：`Video_Similarity-v1.1.0-macos-x64-installer.dmg`
- Linux Debian/Ubuntu：`Video_Similarity-v1.1.0-linux-x64-installer.deb`
- Linux Fedora/openSUSE/RHEL：`Video_Similarity-v1.1.0-linux-x64-installer.rpm`

不想安装时，可以选择同平台文件名中带 `portable` 的便携包，解压后直接运行。

以上安装包和便携包都是轻量应用包，不再内置大型 AI 环境。Windows 新用户第一次启动时，应用会把对应 runtime 安装到所选目录的 `env`：CPU 版通常为数百 MB，GPU 版接近 2 GiB；第一次分析还会把约 600 MB 的 CLIP 模型安装到同一目录的 `models`。旧用户原有的 `env` 和 `models` 会直接复用。

从 v1.1.0 开始，如果后续只是新增按钮、修改合并视频页面、修复界面或业务逻辑，更新程序只下载十几至几十 MB 的应用更新，原有 runtime 和模型会继续使用。只有 runtime 或模型版本确实改变时，才会重新下载对应资产。

`Video_Similarity-runtime-v1-*`、`.sha256`、`*-updater.exe`、`.sig` 和更新 JSON 均由应用自动选择、下载或校验，普通用户不需要手动下载。

Windows GPU runtime 使用 CUDA 13.0，仅适用于 Turing 或更新架构（计算能力 7.5+）且安装 R580+ 驱动的 NVIDIA 显卡。其他设备请选择 CPU 包，避免无效下载。
