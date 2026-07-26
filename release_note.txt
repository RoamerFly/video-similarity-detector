## v1.1.0 新版本内容

本版本重点解决应用小更新仍需重复下载大型 AI 环境的问题，并提升首次安装、旧版迁移和海量视频分析的稳定性。

### 新增与优化

- Windows、macOS 和 Linux 的应用本体与 Python、PyTorch、FFmpeg 运行环境已完全分离。安装包、便携包和日常应用更新不再内置大型 AI 环境与模型。
- Windows 的 `env`、`models` 和 `data` 均保存在用户选择的安装目录内；覆盖更新只替换主程序与业务代码，不改动这些目录。
- 首次启动时，应用会自动安装与当前系统、架构和 CPU/GPU 模式匹配的运行环境，并支持代理、断点续传、取消、失败重试、SHA-256 校验和安全替换。
- Windows 继续提供 CPU 与 GPU 两种模式；GPU 运行环境为小于 2 GiB 的单个 ZIP，不会把同一模块拆成多个 part 压缩包。
- 以后若只更新界面、按钮、合并编辑功能或业务逻辑，通常只需下载十几至几十 MB 的应用更新，已安装的运行环境和模型会继续复用。
- v1.0.x 用户若程序旁仍保留旧 `env`，新版本会自动识别并继续使用；可在“设置”中就地登记，无需移动、复制或重新下载。
- 大型视频库的候选筛选与并行比较改为有界处理，避免一次性创建或提交全部视频组合，降低高峰内存占用。
- 完善合并编辑器的英文界面，提升中英文界面的一致性。

### 修复的问题

- 修复旧任务恢复时仍可能携带超长匹配键的问题，并为任务失败对增加明确计数。
- 修复帧缓存依赖不安全 pickle 数据的问题；旧格式会自动失效并安全重建。
- 固定离线 CLIP 模型版本，并在发布构建和应用安装时执行 SHA-256 完整性校验。
- 修复 macOS/Linux 独立 runtime 解压后可能丢失 Unix 可执行权限的问题。
- Windows CUDA 13.0 runtime 固定使用 PyTorch 2.9.1，并在构建时校验依赖版本，避免复用本地错误环境造成包体膨胀；GPU runtime 保持为小于 GitHub 2 GiB 限制的单个 ZIP。
- 修复 Intel macOS 运行环境中 NumPy 与 OpenCV 版本不兼容、导致依赖安装失败的问题。
- 修复 Windows GPU 版启动时长时间显示白页、界面卡顿以及黑色命令窗口闪现的问题。

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

每个平台和运行模式只提供一个支持断点续传的 runtime ZIP 及对应的 `.sha256` 校验文件，不会出现同一模块的 part 压缩包。
