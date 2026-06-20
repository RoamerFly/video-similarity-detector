# 视频相似度桌面端

这是项目的 Tauri + Vite + React 桌面 UI。界面负责选择目录、配置分析参数、启动 Python 批量分析、展示结果和管理报告；核心算法仍在仓库根目录的 `scripts/` 与 `video_sim/` 中。

## 本地开发

```powershell
npm install
npm run tauri:dev
```

常规检查：

```powershell
npm run lint
npm run build
cd src-tauri
cargo check
```

## UI 使用

1. 在“设置”中确认 Python 路径。保持默认 `python` 时，打包版会优先使用 `dist_windows/env/python`。
2. 在“分析任务”选择视频目录和输出目录。
3. 调整跳帧阈值、匹配阈值、时间窗口、Top-K、最大间隔、裁剪黑边、缩放模式等参数。
4. 点击“扫描视频”确认文件数量。
5. 点击“开始分析”，运行过程中可查看实时 stdout/stderr 日志，也可取消任务。
6. 分析完成后进入“结果总览”，可查看比较结果、匹配片段和时间窗口相似度。
7. 在“报告中心”打开或定位生成的 JSON/CSV/HTML 报告。

## Windows 便携包

```powershell
.\build-windows.bat
```

输出目录：

```text
dist_windows/
├── video-similarity-desktop.exe
├── env/
├── data/
├── scripts/
└── video_sim/
```

常用参数：

```powershell
# 复用已有 env 快速打包
.\build-windows.ps1 -SkipPythonEnv -SkipNpmInstall -SkipFrontendBuild

# 从零重建内置 Python 运行环境
.\build-windows.ps1 -CleanPythonEnv

# 额外生成安装包
.\build-windows.ps1 -BuildInstaller
```

`env/python` 是运行所需的最小 Python 环境，不默认包含 pytest。模型权重不单独复制进 `dist_windows`；离线部署前请先预热 Hugging Face 模型缓存。
