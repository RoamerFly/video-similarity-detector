# 第二轮识别优化：CPU 采样器与预处理报告

日期：2026-08-31
状态：探索性开发测量；入口、digest 对照、CPU 回归和固定重复 base 探索运行已完成。

本轮入口是 `scripts/benchmark_preprocess.py`。它把现有工作树作为 current，
把 `data/upgrade_round2_20260831/baseline` 作为固定 baseline。该 baseline 是第二轮
开始前的第一轮源码快照：`frame_sampler.py` 来自当时保存的 index，`preprocess.py`
来自当时的 HEAD，之后对应第一轮 commit
`deb6ce923c69b21a25c64f5f7391386886f369b4`，不是当前 index。该 commit 已推到
`origin/codex/recognition-optimization-v1`；第二轮修改尚未提交。所有 `data/` 下的
证据均为本地 gitignored 文件，不随 commit 提交。每个变体和每次重复都在新的 Python
子进程中运行，并在导入两端专属模块前共同导入 cv2、NumPy、PIL、imagehash、decord
等依赖。

## 四轮安排

| 轮次 | 计划内容 | 当前边界 |
| --- | --- | --- |
| 1 | B01–B06：主要正确性与资源检查 | B01、B05、B06 仍有未完项；本文件不把 B05 写成完整，也不把本轮当成总体精度结论 |
| 2 | B07：CPU 无损预处理与阶段指标；B08：CUDA 对照 | B07 CPU 预处理/指标子项完成；B07 的真实 PTS/抽帧算法子项未完成；B08 因 CUDA 不可用未开始 |
| 3 | B09–B10：热缓存、增量和大库路径 | 未开始 |
| 4 | B11–B12：复杂变换精化 | 未开始 |

## 测量协议

默认视频是已有的 `data/upgrade_20260831/e2e_fixtures/base.mp4`，也可重复传入
`--video`。默认 `--warmup 2 --repeats 5`；调度按重复交错 AB/BA（A 是旧
baseline，B 是 current）。每个原始重复都保留 wall time、CPU time、retain 数量、
阶段 metrics，以及进程 baseline/current/peak RSS 和采样 peak delta。

采样参数固定为 `skip_threshold=0.90`、`max_gap_sec=5.0`、`frame_step=1`，并将
完整 `PreprocessConfig` 一起写入每个 worker 结果。`decode_sample` 是完整
`sampler.sample` 的 inclusive wall interval，包含解码、颜色转换、几何、pHash、
保留帧处理和 sampler 遥测；`sampler_*` 与 `preprocess` 是其中的嵌套诊断，不能
相加后当成另一段解码时间。旧 baseline 没有 `sampler_sampled_frames` 计数时，结果
明确写为 unavailable；保留数量使用 `frames_retained`，不会把总视频帧数当成采样尝试数。

这里的“冷 frame cache”仅表示不读取或复用应用层 frame cache。脚本不刷新操作系统
page cache，warmup 和前序重复可能使 decoder 读变成 OS 热读。RSS 是 best-effort
进程工作集/峰值采样；peak delta 不是硬 RSS 上限，也不是纯分配量。

正确性 digest 流式覆盖每个 retained frame 的 frame index、timestamp、phash 和
CLIP 像素（含形状与 dtype）。baseline/current 任一对应重复的 digest 不同，CLI
返回非零退出码。性能只报告每次原始重复和 median，不计算 p-value 或 CI，也不宣称
总体精度或端到端提速；前轮 CPU 模型耗时仍是主要耗时来源。

可选 `--micro` 会按次生成单个 NumPy 合成帧，覆盖 1080p、4K、竖屏和黑边 crop
开关。帧生成在计时外，4K 帧在下一个 case 前释放。报告分别显示 geometry、hash
pipeline、clip pipeline，并额外测量 `DynamicFrameSampler._consider_frame` 强制
保留单帧的 `sampler_combined_wrapper`；后者标记为 wrapper 诊断，不作为生产端到端
测量。micro 正确性 digest 只覆盖 wrapper 产出的 phash 与 CLIP 像素，不混入时间和
资源遥测。

## 运行示例

```powershell
python scripts/benchmark_preprocess.py `
  --baseline-dir data/upgrade_round2_20260831/baseline `
  --video data/upgrade_20260831/e2e_fixtures/base.mp4 `
  --output data/upgrade_round2_20260831/benchmark_preprocess.json
```

轻量探索性开发测量可用 `--warmup 0 --repeats 1`。新增的测试只验证入口、基线绑定、digest
覆盖、真实 base sampler 对照和 micro wrapper 结构；测试不对速度作 unit-test 断言。

## 结果记录

首组固定重复探索性开发测量使用 `--warmup 2 --repeats 5 --micro`，结果保存在
`data/upgrade_round2_20260831/benchmark_preprocess.json`：5 次视频 digest 与 5 次
micro digest 全部通过，视频每次保留 3 帧（indices `0,20,40`），micro 的 6 个 case
（1080p、4K、竖屏，各自 crop on/off）也全部通过。base.mp4 的原始 wall median
为 baseline `35.974 ms`、current `41.009 ms`；这些数字只描述本机这次探索性运行，
在这个小视频上 current 的观测 wall median 约高 14%，不能据此作总体提速判断，
也不能隐去这项回退。JSON 保留每次 raw wall/CPU、阶段指标和 RSS 字段。

同一次运行的 micro 组合 wrapper median（ms）如下；wrapper 仅用于诊断共享几何
路径，不能当成生产端到端时间：

| case | baseline | current |
| --- | ---: | ---: |
| 1080p, crop off | 8.879 | 5.652 |
| 1080p, crop on | 12.106 | 6.585 |
| 4K, crop off | 31.582 | 18.234 |
| 4K, crop on | 39.270 | 18.775 |
| portrait, crop off | 19.427 | 10.404 |
| portrait, crop on | 16.420 | 9.685 |

这组结果是 first run。first run 的 source identity 尚未记录后来新增的
`metrics.py` 和 benchmark script SHA256；这组记录仍保留供复核，不能因为后续修复而
删除或改写。

补充的 cProfile 诊断显示，小视频一次约 44 ms 的 current 路径中，
`_flush_sampler_metrics` 约 6 ms；其中每个视频 8 次 `snapshot_resources` /
`process_memory_snapshot` 累计约 6 ms。这说明遥测开销会影响小样本 wall time，
不能把该轮差异直接解释成算法差异。修复采用 `metrics.add_elapsed_batch`，把每个
视频的 8 次快照批量录入为 1 次；这不能隐去 first run 的回退。Windows
`process_time()` 的观测粒度约为 15.625 ms，因此本报告只保留原始 CPU ms，不用它
计算精确 CPU 利用率。

配套的第二轮实际识别验收记录为 `data/upgrade_round2_20260831/e2e-after.json`
及其日志：CPU 状态通过，6 个 fixture 的保留帧数为 `24/6/6/6/3/48`，15 对比较
完成，warnings 和 failed pairs 均为 0；CUDA 不可用，因此 B08 仍未开始。独立读取
第一轮与第二轮 CPU `frame_features.npz` 的 6 份缓存时，indices、timestamps、
phashes、embeddings 均逐项相等（6/6）。这些是本地验收证据，不构成总体精度或统计
显著性结论。

## 最终 CPU 预处理探索性开发测量

最终结果保存在 [`data/upgrade_round2_20260831/benchmark_preprocess_final.json`](../data/upgrade_round2_20260831/benchmark_preprocess_final.json)。
配置为 `--warmup 2 --repeats 5 --micro`，5 次重复按 AB/BA 交错调度，状态为 `ok`，
视频和 micro correctness 均为 pass。各 variant 在重复中的 source hash 固定；current
的 `preprocess.py`、`frame_sampler.py`、`metrics.py` 三份生产源码 hash 与最终工作区
一致，baseline 来自固定快照。benchmark script 后来仅作测量口径修正，旧产物中的
benchmark script hash 按原 JSON 记录保留。

`base.mp4` 的 raw wall ms 和中位数如下；这些数字都是本机本次探索性开发测量：

| variant | 5 次 raw wall ms | median wall ms |
| --- | --- | ---: |
| baseline | `30.854, 32.910, 32.997, 35.366, 39.178` | 32.997 |
| current | `33.332, 34.206, 34.045, 33.069, 32.593` | 33.332 |

这组完整采样没有显示清晰的端到端采样提速；不能称为全面收益，也不能把局部
wrapper 的下降外推为生产推理收益。首组测量中 `smallvideo` 的 wall median 仍为
baseline `35.974 ms`、current `41.009 ms`，该首次回退已保留在前述
`benchmark_preprocess.json`。

最终 `sampler_combined_wrapper` 中位数（ms）如下。它是单帧强制保留的诊断，用于
观察共享几何路径，不是端到端推理测量：

| case | baseline | current |
| --- | ---: | ---: |
| 1080p, crop off | 8.407 | 5.899 |
| 1080p, crop on | 10.287 | 6.143 |
| 4K, crop off | 29.508 | 17.805 |
| 4K, crop on | 35.252 | 18.943 |
| portrait, crop off | 18.148 | 11.648 |
| portrait, crop on | 16.962 | 9.414 |

B07 的实现摘要是：每个候选共享 crop/rotate；hash 使用 AREA、CLIP 使用 LINEAR，
两条 resize 路径保持独立；使用 `uint8` 避免重复 copy；public 返回独立数组且不改变
输入 flags；七个 sampler stage 在视频末尾批量录入。`decode_sample` 是 inclusive
区间，包含嵌套的 sampler/preprocess 诊断，不能与子 stage 相加。

RSS 字段表示进程终生 highwater 相对采样 baseline 的观测值，不能冒充本阶段峰值或
内存提升。最终数据中的约 181 MB delta 基本来自两边进程的历史峰值，不能报告为本
阶段采样额外内存或资源收益。

## 最终识别回归

最终 Python 回归日志 [`data/upgrade_round2_20260831/python-acceptance-final.log`](../data/upgrade_round2_20260831/python-acceptance-final.log)
显示 246 passed；并行的 `tests/test_merge_video_filters.py` 被排除在该回归之外。
恢复后的全识别回归日志 [`data/upgrade_round2_20260831/python-acceptance-resumed.log`](../data/upgrade_round2_20260831/python-acceptance-resumed.log)
同样为 246 passed（14.67 s）。最终 CLIP E2E 记录
[`data/upgrade_round2_20260831/e2e-final.json`](../data/upgrade_round2_20260831/e2e-final.json)
及其 [`e2e-final.log`](../data/upgrade_round2_20260831/e2e-final.log) 完成 15 对比较，
warnings 为 0、failed 为 0；CUDA 不可用，B08 未验证。测量环境为 Python 3.13.13、
torch 2.9.1+cpu（CUDA=false）、OpenCV 4.13.0、Windows 11。

独立检查显示 6 份旧新 E2E cache，以及最终 E2E cache，indices、timestamps、phash 和
embeddings 均逐字段精确相等（6/6）；主任务的 384 像素检查与所有权检查也通过。
这些结果支持本轮 CPU 路径的无损回归，不构成精度增加或总体精度结论。

补充的内存审计 [`data/upgrade_round2_20260831/benchmark_preprocess_memory_audit.json`](../data/upgrade_round2_20260831/benchmark_preprocess_memory_audit.json)
及其日志在依赖提前预热后完成 `warmup=2`、`repeats=1`、无 micro 的探索性开发测量，
correctness 为 pass。新增字段 `process_peak_minus_baseline_rss_bytes`，旧的
`sample_peak_delta_bytes` 明确为 deprecated alias；该单次审计只验证字段和采样口径，
不能替换原 5 次性能结论。审计不支持内存下降结论，RSS 仍按进程历史 highwater 解释，
不能报告为本阶段采样峰值或额外内存收益。
