## 新版本内容

本版本重点完善了视频合并页面的播放体验、结果展示逻辑以及针对海量视频分析时的底层稳定性。

### 新增与优化

- 优化合并视频页面：新增双进度条展示，下方长进度条代表全局总进度，右侧短进度条精准显示当前单片段进度。
- 完善多片段音频的联动逻辑：播放至下一片段时右侧音量状态可实时、准确跟随切换。
- 增强“统一音量”功能：增加“统一成功”的操作提示，并加强按钮反馈。
- 优化结果总览页面逻辑：明确“删除与该视频相关记录”只删除相关比较记录，不影响整个报告文件。

### 修复的问题

- 修复海量视频开始分析时，进程参数过长导致 Windows 命令行长度超限的问题。
- 修复特定情况下的音频播放与同步问题。
- 修复前端 TypeScript 构建错误和 GPU Windows 打包进程占用问题。

## 下载建议

- Windows CPU 安装版（推荐大多数用户）：下载 `Video_Similarity-v1.0.14-windows-x64-cpu-installer.exe`
- Windows CPU 便携版（免安装）：下载 `Video_Similarity-v1.0.14-windows-x64-cpu-portable.zip`，解压后运行 `video-similarity-desktop.exe`
- Windows GPU 安装版（适用于兼容 NVIDIA/CUDA 的设备）：下载 `Video_Similarity-v1.0.14-windows-x64-gpu-installer.exe`
- Windows GPU 便携版：下载 `Video_Similarity-v1.0.14-windows-x64-gpu-portable.zip`，解压后运行 `video-similarity-desktop.exe`
- macOS Apple Silicon / M 系列：下载 `Video_Similarity-v1.0.14-macos-arm64-installer.dmg`
- macOS Intel：下载 `Video_Similarity-v1.0.14-macos-x64-installer.dmg`
- Linux Debian/Ubuntu：下载 `Video_Similarity-v1.0.14-linux-x64-installer.deb`
- Linux Fedora/openSUSE/RHEL：下载 `Video_Similarity-v1.0.14-linux-x64-installer.rpm`
- Linux 通用便携：下载 `Video_Similarity-v1.0.14-linux-x64-portable.tar.gz`

`*-updater.exe`、`.sig` 和 `latest.json` / `windows.json` / `darwin.json` / `linux.json` 用于应用内自动更新和签名校验，普通用户无需手动下载。
