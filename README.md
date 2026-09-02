<p align="center">
  <a href="README.md">简体中文</a> | <a href="README_EN.md">English</a>
</p>

<p align="center">
  <img src="icon.png" alt="Video Similarity Detector" width="112">
</p>

<h1 align="center">视频相似度检测</h1>

<p align="center">在本地查找相似视频、片段包含关系和重复文件，并提供视频整理与合并工具。</p>

<p align="center">
  <a href="https://github.com/RoamerFly/video-similarity-detector/releases"><img src="https://img.shields.io/github/downloads/RoamerFly/video-similarity-detector/total?style=flat-square" alt="下载量"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-22c55e.svg" alt="MIT License"></a>
</p>

## 快速入口

- [下载最新版](https://github.com/RoamerFly/video-similarity-detector/releases)：选择与你的系统匹配的安装包或便携版。
- [普通用户图形界面操作手册](https://roamerfly.github.io/video-similarity-detector/)：从安装、环境配置到分析、复核和视频合并的详细步骤。
- [开发者 API 文档（GitHub Wiki）](https://github.com/RoamerFly/video-similarity-detector/wiki)：项目架构、API/CLI、识别逻辑、数据结构、构建和发布说明。

## 主要功能

- 扫描本地视频，识别相似视频、片段包含、部分重叠和完全重复文件。
- 使用动态抽帧、CLIP 特征和相似度匹配，支持快速、普通、精确和完美匹配等模式。
- 生成并查看 JSON、CSV、HTML 报告，支持筛选、排序、对比复核和任务断点恢复。
- 提供多轨视频合并编辑器，支持视频、音频和文本片段的排列、剪辑与导出。
- 默认在本机处理视频、模型、缓存和报告，不上传媒体内容。

## 安装与使用

1. 从 [Releases](https://github.com/RoamerFly/video-similarity-detector/releases) 下载对应系统的安装包。Windows 普通用户优先选择 CPU 版；只有具备兼容 NVIDIA 显卡和驱动时才选择 GPU 版。不想安装可以使用 portable 便携版。
2. 首次启动后打开“设置”，确认视频目录、缓存目录和报告目录，并检查 AI 运行环境、离线 CLIP 模型和视频合并环境。
3. 进入“分析任务”，扫描视频、选择分析模式并开始任务。分析完成后，在“结果总览”和“对比视图”中复核结果。
4. 需要整理素材时，可在结果页面移动或删除视频，也可以进入“合并视频”编辑并导出新文件。

AI 相似度分析首次运行可能需要下载 Python/PyTorch 运行环境和 CLIP 模型；视频合并使用独立的 FFmpeg 环境。它们分别安装和更新，后续启动会复用本地环境。只检查完全相同的文件时，可使用“对比相同文件”模式，无需进行 CLIP 抽帧分析。

## 界面预览

以下截图来自桌面应用实际界面。

### 分析任务

![分析任务界面](docs/screenshots/analyze.png)

### 结果总览

![结果总览界面](docs/screenshots/results.png)

### 对比视图

![对比视图界面](docs/screenshots/compare.png)

### 多轨合并编辑器

![多轨合并编辑器](docs/screenshots/merge.png)

### 设置

![设置界面](docs/screenshots/settings.png)

## 开发者入口

开发者请优先阅读 [GitHub Wiki](https://github.com/RoamerFly/video-similarity-detector/wiki)。源码中的识别逻辑补充说明见 [README_RECO.md](README_RECO.md)，设置与参数说明见 [README_SET.md](README_SET.md)。

本地开发环境需要 Node.js/npm、Rust/Cargo 和 Python 3.10+：

```powershell
cd desktop
npm install
npm run dev
```

Python 依赖安装：

```powershell
python -m pip install -r requirements.txt
```

## 隐私、许可证与免责声明

- 视频默认只在本机处理，应用不会主动上传媒体内容。
- 删除源视频不可恢复，请在操作前确认并做好备份。
- 分析结果可能存在误判或漏判，不应作为版权、法律或平台执法的唯一依据。使用者应确保拥有处理相关媒体的合法权利，并遵守适用法律、平台规则及第三方许可证。
- 本项目基于 [MIT License](LICENSE) 开源；第三方依赖、模型和媒体内容遵循各自许可证。
