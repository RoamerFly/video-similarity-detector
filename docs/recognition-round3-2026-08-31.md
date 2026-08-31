# 第三轮识别优化：热缓存、增量与大库执行路径

日期：2026-08-31
状态：探索性开发测量；候选摘要、有限窗口调度和 SQLite 写入路径的语义验收通过。

本轮围绕 B09–B10 展开，共四轮计划中的第三轮。生产改动由主任务另行验收；本文件只记录第三轮 benchmark 的边界和证据。基准入口为 [`scripts/benchmark_round3.py`](../scripts/benchmark_round3.py)，实际结果为 [`data/upgrade_round3_20260831/benchmark_round3.json`](../data/upgrade_round3_20260831/benchmark_round3.json)。

## 四轮安排

| 轮次 | 主要内容 | 状态与边界 |
| --- | --- | --- |
| 1 | B01–B06：正确性、结果/缓存身份、时序对齐、资源池和可观测性 | 已完成第一轮实现与回归；未把它写成总体精度提升 |
| 2 | B07–B08：CPU 无损预处理、采样器指标、CUDA 对照 | CPU 子项已完成；真实 PTS/抽帧算法子项未做，CUDA 因环境不可用未测 |
| 3 | B09–B10：热缓存、增量、大库精确比较和断点存储 | 本文件；候选摘要、调度与 SQLite 对照完成，语义守恒通过 |
| 4 | B11–B12：候选片段二次验证、边界精化、复杂变换与模型对照 | 未开始，必须建立标注评估集后再进入 |

总计划为四轮。第三轮没有扩大到 B11–B12，也没有改变候选阈值、匹配阈值、模型或 CUDA 路径。

## 本轮实际范围

B09 持久化每个视频的 `candidate_summary.npz` sidecar。sidecar 会校验 schema、selector 版本、缓存 metadata、embedding shape/dtype、摘要参数和源 NPZ 的 ZIP central-directory CRC 身份。热审计只读取 sidecar 及源缓存的轻量 artifact identity，不调用完整 `FrameEmbeddingCache.load_valid`；sidecar 缺失、损坏或身份失效时才回退一次完整缓存加载并尝试重建。完整的 timestamps 和 auxiliary signatures 仍然保留，因为当前候选证据需要它们，所以 sidecar 总体空间仍为 O(N)；只有 embedding sketch 是有上限的，不能把它描述成完全与帧数无关。

新增视频时，已有视频的摘要和已完成 pair 结果可以复用，但候选筛选仍会对当前视频集合重新计算双向候选并集。没有在本轮实现近似的全局 HNSW 增量维护，也没有因为“只查询新视频”而宣称与全量筛选等价。

B10 将待执行 pair 在有限窗口内按共享视频端点做确定性局部排序。调度只改变执行顺序，保留 pair 的方向、report ordinal、key 和结果 payload；最终报告仍按原 candidate 顺序 materialize。SQLite 使用单一主线程 `ResumeSQLiteWriter`，每个 pair 仍立即 commit，以保持原有崩溃边界；恢复读取使用 `fetchmany`。如果 writer 初始化失败，逐 pair 回退到 legacy SQLite 写入路径并保留 warning，不能让断点存储问题把视频对比较标记为失败。相关回归补充了两项 writer 初始化失败/legacy fallback 测试。本轮没有把报告 JSON/CSV/HTML 改成真正的逐行流式输出，现有 reporter 仍会 materialize 报告行。

## 测量协议

默认命令如下：

```powershell
$env:PYTHONPATH=(Resolve-Path 'data/analysis_20260831/test_deps').Path
python scripts/benchmark_round3.py `
  --output data/upgrade_round3_20260831/benchmark_round3.json `
  --cache-dir data/upgrade_round3_20260831/synthetic_cache
```

默认配置为 8 个 synthetic cache、每个 128 帧、32 维向量、`seed=20260831`；摘要审计预热 1 次，正式重复 3 次，顺序为每次 `full, hot, hot, full`。SQLite 及其对照重复也使用 `prior, current, current, prior`。缓存文件和 sidecar 在计时前生成，基准不刷新操作系统 page cache；因此这是本机 OS page cache 可能已热的重复测量，而不是物理磁盘冷读测量。调度使用 1000 个 pair、窗口 64、resident capacity 2；SQLite 使用 1000 行、256 行 `fetchmany`。

完整摘要路径的计时包含 `load_valid + build_candidate_summary`，hot 路径的计时只包含 `load_candidate_summary`。候选 pair digest 在计时外分别对完整摘要和加载后的 sidecar 摘要执行相同 selector，作为语义护栏。SQLite 的 prior 是脚本内可重复的历史模式模拟：每行重新连接、设置 PRAGMA、执行 DDL、写入并 commit；它不是历史运行日志。

## 默认实际结果

环境和 source identity 已写入 JSON：Python 3.13.13、Windows 11、NumPy 2.2.6，source SHA 为 `7d9ea63a93bd108b00a0400c514c908e556c14c6`；运行时工作树包含其他并行开发修改，因此该 SHA 表示 HEAD，不是整个工作树快照。所有结果都是本机探索性数字，JSON 保留每次 raw 运行。

### B09：完整缓存审计与 hot sidecar

| 路径 | raw wall ms（12 次交错运行中的对应 6 次） | median wall ms | CPU median ms |
| --- | --- | ---: | ---: |
| full load + build summary | `38.727, 38.457, 37.773, 36.685, 35.893, 35.051` | 37.229 | 31.250 |
| hot load sidecar | `25.221, 24.814, 22.132, 22.499, 21.106, 21.728` | 22.316 | 15.625 |

这组 synthetic 产物的 frame cache 合计 230,800 bytes，sidecar 合计 211,475 bytes。两条路径的每视频 summary semantic digest 相等；candidate pair digest 均为 `f744a3617d7e0b86371484a01a242c6f456bc0b8bd2f7db691521f93b5b1814a`，各得到 16 对。该结果支持“hot 审计避免加载完整 embedding 数组且候选语义守恒”的工程判断，不支持真实 CLIP 端到端提速或准确率提升结论。文件压缩比会随 embedding 维度、帧数、重复内容和压缩库改变，不能把这一组 bytes 外推到用户媒体。

### 真实 CLIP E2E：cold、hot 与 clean incremental

在 synthetic 结果之外，主任务使用本地 CLIP fixture 做了三组真实入口验收。证据文件为 [`e2e-cold_batch.json`](../data/upgrade_round3_20260831/e2e-cold_batch.json)、[`e2e-hot_batch.json`](../data/upgrade_round3_20260831/e2e-hot_batch.json)、[`e2e-clean-base_batch.json`](../data/upgrade_round3_20260831/e2e-clean-base_batch.json) 和 [`e2e-clean-incremental_batch.json`](../data/upgrade_round3_20260831/e2e-clean-incremental_batch.json)。首次 cold E2E 的 source SHA 是 dirty tree 的 HEAD 基线 `7d9ea63a93bd108b00a0400c514c908e556c14c6`；该 SHA 不表示这些尚未提交的第三轮改动已经包含在 commit 中。

`e2e-cold_batch.json` 使用 6 个视频、15 对，warnings 为 0。6 个 sidecar 全部 miss，6 个重建，完整 frame NPZ audit 为 6 次，读取 bytes 为 325,448；调度预测 misses 从 19 降到 17。实际资源池成功加载 17 次、失败 0 次、hits 13、misses 17、evictions 15；SQLite writer 使用 1 条连接并完成 15 次 commit；报告 wall metric 为 3,666.760 ms。

`e2e-hot_batch.json` 仍完成相同的 15 对且 warnings 为 0。6 个 sidecar 全部命中，miss/rebuild 均为 0，完整 frame NPZ audit 为 0；调度和资源池计数与 cold 相同（预测 misses 19→17，实际 successful 17/failed 0/hits 13/misses 17/evictions 15），writer 仍为 1 条连接和 15 次 commit。去除 `completed_at` 后的 15 对语义 digest 为 `cbf206...780b`，wall metric 为 3,058.399 ms。这只是一次本机观察，不能据此宣称 hot E2E 在普遍环境中提速。

ordinal 泄漏修复后，`e2e-clean-base_batch.json` 与 `e2e-clean-incremental_batch.json` 提供了干净的增量对照：base 为 15 对，新增一个复制 fixture 后 incremental 为 21 对；两者原有 15 对去除 `completed_at` 后完全相等，digest 均为 `654448...874b`，输出中不再出现 `report_ordinal`。incremental 侧 6 个既有 summary 命中、1 个 miss、1 个 rebuild，恢复读取 15 rows，pending 为 6，writer commit 为 6，实际资源池 successful 为 7、failed 为 0，warnings 为 0。新增 fixture 已从输入目录删除。该结果证明本次 clean incremental 的旧 pair 复用和输出契约，不能外推为任意新增视频集合的全量候选等价性。

### B10：1000 pair 有限窗口调度

输入由确定性 cluster 组成，每个四视频 cluster 有四条交错边；窗口内按共享端点重排。顺序守恒检查通过：1000/1000 个 work item 对象身份保留，pair direction、ordinal、key 和合成 result digest 均不变。

| sequential LRU 预测 | 原序 | 调度后 |
| --- | ---: | ---: |
| pairs | 1000 | 1000 |
| endpoint loads | 2000 | 2000 |
| misses | 2000 | 1250 |
| hits | 0 | 750 |
| evictions | 1998 | 1248 |
| shared endpoint transitions | 0 | 750 |

这些 hit/miss/eviction 是容量为 2 的顺序模型预测值，不是并发 `ExactResourcePool` 的实际计数。调度基准本身的单次 wall time 为 885.605 ms，主要包含确定性窗口选择和诊断；它不能当成精确比较阶段的耗时。

### B10：SQLite 断点写入与恢复读取

| 路径 | raw wall ms（12 次交错运行中的对应 6 次） | median wall ms | 每行连接数 | commits | `fetchmany` batches |
| --- | --- | ---: | ---: | ---: | ---: |
| prior reconnect + setup + commit | `12354.862, 11884.486, 11566.803, 11840.332, 11407.720, 12966.869` | 11,862.409 | 1000 | 1000 | 4 |
| current single writer + per-row commit | `97.020, 100.742, 96.784, 96.820, 112.608, 103.039` | 98.881 | 1 | 1000 | 4 |

两条路径读回均为 1000 rows，payload digest 均为 `d2b3f82c178ff1172e3e6586d1be9b76813b7f0ab67c4063ac60896669ca0079`，commit 数和读取批次数相同。该结果只说明在当前 Windows 临时本地 SQLite 环境中，重复连接/初始化开销很大；它不能外推到完整视频识别时长，也不能掩盖磁盘、锁竞争或异常恢复场景的差异。

## 验收与限制

第三轮 benchmark 的正确性状态为 `ok`：摘要语义和 candidate pairs 守恒，调度的对象身份/方向/ordinal/result digest 守恒，SQLite 的 rows/payload/commits/read batches 守恒。真实 CLIP cold/hot 均为 6 视频、15 对、0 warnings；clean incremental 的旧 15 对 digest 守恒且输出无 `report_ordinal`。配套测试验证 JSON 结构、digest、计数、默认 1000 pair 场景和 CLI smoke；不对速度写断言，避免把机器噪声固化为测试契约。主任务的最终全量识别回归为 316 passed、1 warning、23.45 s，日志为 [`python-acceptance-final.log`](../data/upgrade_round3_20260831/python-acceptance-final.log)；warning 来自测试故意构造重复 ZIP member 时 `zipfile` 发出的 `UserWarning`，与生产路径无关，且排除了无关的 `tests/test_merge_video_filters.py`。

本轮可支持的三维结论如下：

- 精确度：只证明候选和已有结果语义守恒，没有证明总体 precision、recall 或关系分类提升。
- 识别时长：只对 hot cache audit、有限窗口调度预测和 SQLite 对照做了探索性测量；未证明完整端到端 wall time 降低。
- 资源：hot audit 可以避免常规审计加载完整 embedding 数组，单连接 writer 可以减少连接/初始化抖动；summary 仍因完整 timestamps/signatures 为 O(N)，最终 report 仍 materialized。

CUDA 未测。B07 的真实 PTS/抽帧算法子项也未在本轮补做。下一轮 B11–B12 需要先固定带人工标签的评估集、短片段与复杂变换反例，并预先定义准确率、边界误差、额外耗时和资源护栏；在此之前不应把本轮局部 benchmark 数字写成产品精度或总体性能承诺。
