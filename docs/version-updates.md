## 新版本内容

本版本重点完善了视频合并页面的播放体验、结果展示逻辑以及针对海量视频分析时的底层稳定性。

### 新增与优化

- 优化合并视频页面：新增双进度条展示，下方长进度条代表全局总进度，右侧短进度条精准显示当前单片段进度。
- 完善多片段音频的联动逻辑：播放至下一片段时右侧音量状态可实时、准确跟随切换。
- 增强“统一音量”功能：增加“统一成功”的操作提示，并稍微加强了按钮按下的视觉反馈动画。
- 优化结果总览页面逻辑：明确“删除与该视频相关记录”操作为仅删除相对比的记录条数，不再错误影响整个报告文件。

### 修复的问题

- 修复了分析阶段，开始分析海量视频时，因进程参数过大导致的 Windows 命令行长度超限报错问题。
- 解决了音频在特定情况下的播放与同步问题。
- 修复因 TypeScript 缺失属性导致的前端构建失败，以及 GPU Windows Packager 构建时的进程占用问题，提升整体编译打包稳定性。

## 下载建议

- Windows 安装版（推荐大多数用户）：下载 `Video_Similarity-v1.0.14-windows-x64-installer.exe`
- Windows 便携版（免安装）：下载 `Video_Similarity-v1.0.14-windows-x64-portable.zip`，解压后运行里面的 `Video Similarity.exe`
- macOS Apple Silicon / M 系列：下载 `Video_Similarity-v1.0.14-macos-arm64-installer.dmg`
- macOS Intel：下载 `Video_Similarity-v1.0.14-macos-x64-installer.dmg`
- Linux Debian/Ubuntu：下载 `Video_Similarity-v1.0.14-linux-x64-installer.deb`
- Linux Fedora/openSUSE/RHEL：下载 `Video_Similarity-v1.0.14-linux-x64-installer.rpm`
- Linux 通用便携：下载 `Video_Similarity-v1.0.14-linux-x64-portable.tar.gz`

`.sig` 和 `latest.json` 主要用于自动更新与签名校验，普通安装通常不需要手动下载。
