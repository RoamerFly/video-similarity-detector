# 第四轮：带区间标签的识别评估协议

日期：2026-09-01
状态：开发集探索性验证协议，尚未形成用户总体精度结论

## 目的和边界

第四轮新增一个与识别器解耦的区间评估层。它只读取显式标签和已有识别报告，计算内容复制候选的区间定位与关系判定指标；不训练模型、不下载模型，也不把识别器输出反向写入标签。当前 `data/` 中没有被确认属于人工标注的数据集，因此本轮生成的开发集只能称为 `generated` development evidence，不能称真实用户总体精度或正式 holdout 结果。正式 holdout 入口保留给用户明确提供的 `human` 标注，并要求记录标注者、复核状态和来源。

三轮默认识别语义保持不变（默认 refinement `off`）。`copy`/`copy-mirror` refinement 是已有候选的内容复制证据字段，不引入新的 CLIP 模型。第四轮分别报告原始 `coarse`、已验证 proposal 替换后的 `refined`，以及只保留 verified proposal 的 `verified_copy`；没有运行、abstained、证据不足或预算耗尽的样本会保留在分母中，空 proposal 对正例产生 FN，对负例产生 0 FP，绝不推断为 unrelated。

当 refinement item 带 v2 `proposal_adoptable` 字段时，只有 `proposal_adoptable=true` 且 `status=verified` 才能进入 refined/verified_copy；`false` 或其他 status 永不被采纳。`verified+false` 和非 verified+true 都是矛盾组合并拒绝。没有该字段的历史 v1 报告沿用旧的 verified+proposal 约定。v2 的核心安全策略只允许 proposal 扩展或完整覆盖 coarse 区间；局部支持不足时保留 coarse，不自动裁剪 coarse 区间。

## 严格 manifest schema v1

评估入口是 `video_sim.evaluation` 的 `load_manifest`、`validate_manifest` 和 `evaluate_report`。manifest 顶层必须是 JSON object，且包含：

```json
{
  "schema_version": 1,
  "content_type": "content_copy",
  "split": "development",
  "annotation_source": "generated",
  "annotation": {
    "generator": "scripts/benchmark_round4.py",
    "seed": 20260831,
    "description": "labels follow the fixture construction transform"
  },
  "videos": [
    {
      "id": "base",
      "path": "fixtures/base.mp4",
      "duration_seconds": 12.0,
      "sha256": "<64 lowercase hex characters>",
      "width": 320,
      "height": 180,
      "fps": 12
    }
  ],
  "cases": [
    {
      "id": "base-exact",
      "video_a": "base",
      "video_b": "exact",
      "groups": ["exact"],
      "expected_related": true,
      "expected_relation": "B_is_likely_clip_of_A",
      "segments": [
        {"a_start": 3.0, "a_end": 6.0, "b_start": 0.0, "b_end": 3.0}
      ],
      "transform": {"kind": "trim"}
    }
  ]
}
```

`split` 只能是 `development` 或 `holdout`，`annotation_source` 只能是 `generated` 或 `human`。generated 必须有 generator 和有限整数 seed；human 必须显式给出 annotator、review_status、provenance，不能从文件名猜标签。video id、case id 唯一；video path 必须相对 manifest，路径 canonical 后也必须唯一，并带可校验的 64 位 sha256 和正 duration。case 禁止自配对、重复 unordered pair，groups 不重复；四个端点都是有限非负数，区间采用半开 `[start,end)`，正例须有正宽度区间且不能越过媒体 duration，负例不带真值区间。未知字段、布尔数值、NaN/Inf 和越界值都会报错。

报告必须以 manifest 中媒体的完整绝对路径对齐（batch 的 `video_pairs` 或单个 `video_a_path`/`video_b_path`；单报告 `video_a`/`video_b` 也必须是完整绝对路径），只给 basename 会拒绝。若历史 batch 是从相对运行目录写出的，操作员必须显式传 `--report-media-root <原运行cwd绝对路径>`；评估器只在该 root 下解析相对路径，不搜索或猜测文件名。报告可包含 manifest 外的额外 pair，但必须显式启用 `allow_extra_pairs`，结果会计为 ignored；manifest 中缺失的 case 作为空预测并标为 `incomplete`，不伪装为完整成功。反向 pair 会交换 A/B 区间后再评估；同一个 case 重复出现会报错。

## 指标和匹配规则

预测区间与标签区间必须在 A、B 两侧同时达到 IoU 阈值（默认两侧均 `>= 0.5`）才构成候选匹配。匹配采用确定性的最大基数一对一匹配，重复预测不能重复计 TP；未匹配预测是 FP，未匹配标签是 FN。每个 view 和每个 case/group 输出 TP、FP、FN、precision、recall、F1；零分母使用 null。每个匹配同时记录 A/B 双侧 IoU、最小/平均 IoU，以及四个端点的绝对边界误差和四端点平均误差；聚合报告 mean/max 边界误差。

正例的 pair 关系判定同时要求有合法区间匹配和报告关系为 related。负例不产生 TP；任意预测区间或 related 关系都单列为 `negative_fp`/`negative_pair_fp`。`verified_copy` 的 related 判定只由 verified proposal 决定，其他状态不自动变成 unrelated；其空 proposal 仍按完整标签集合计分。若整个报告没有 refinement，`views.verified_copy.available=false` 且 `status=not_run`，但仍保留所有 case 的计数。

## 开发集构造和正式入口

`scripts/benchmark_round4.py --generate-fixtures` 使用本地 ffmpeg/ffprobe（或环境变量 `VIDEO_SIM_FFMPEG`、`VIDEO_SIM_FFPROBE`），固定 seed `20260831`，生成 320x180、12 fps、最长 12 秒的全新目录 `data/upgrade_round4_20260831/fixtures`，不下载素材，也不覆盖前三轮目录。固定组包括：`exact`、`short`（1.5 秒）、`mirror`、`crop`、`2xspeed`、`unrelated`、`shared_static_template`。标签来自明确的 trim、镜像、裁剪和变速构造；`shared_static_template` 只共享静态模板且内容不同，作为困难静态负例。生成后 ffprobe 核对实际 duration、fps 和 frame_count，manifest 写入这些实测值、每个文件的 sha256 和构造来源。生成是标注协议的一部分，不能被模型结果调参。

fixture 目录只有在空目录首次生成，或存在由本脚本写入且 schema/generator/seed、文件名和 sha256 全部匹配的 ownership marker 时才可使用。无 marker 的同名素材、marker hash 改变、symlink/reparse 路径和目录外路径都会拒绝；`--force` 也只允许删除已确认属于本脚本的直接子文件，不递归清理用户文件。

生成后可用：

```text
python scripts/benchmark_round4.py --generate-fixtures
python scripts/benchmark_round4.py --manifest <manifest.json> --report <batch.json> --report-media-root <original-run-cwd> --allow-extra-pairs --output <evaluation.json>
python scripts/benchmark_round4.py --refine-report <batch.json> --report-media-root <original-run-cwd> --refined-output <refined.json> --refinement-mode copy
```

当前 baseline 是 9 个 fixture 的全 pair 报告，而开发 manifest 只标注 7 个固定 pair，因此解读该报告时使用 `--report-media-root <项目绝对路径> --allow-extra-pairs`；其余 29 个 pair 会明确列入 `ignored_extra_pairs`，不会混入指标。

冻结这批开发输入后，CPU CLIP baseline 使用本机已有 checkpoint，不下载模型；对这批新 fixture 直接调用既有 batch CLI，例如：

```text
set VIDEO_SIM_CLIP_MODEL_DIR=<existing-local-clip>
python scripts/batch_compare.py --input data/upgrade_round4_20260831/fixtures --cache-dir data/upgrade_round4_20260831/clip-cache --output data/upgrade_round4_20260831/clip-baseline --task-id round4-baseline --candidate-limit 0 --skip-threshold 0.90 --max-gap-sec 0.5 --frame-step 1 --match-threshold 0.95 --top-k 10 --min-segment-duration 1 --min-segment-matches 3 --offset-tolerance 3 --compare-workers 1 --disable-early-stop --device cpu --skip-stream-validation
```

本次探索固定参数为：`skip_threshold=0.90`、`max_gap_sec=0.5`、`frame_step=1`、`match_threshold=0.95`、`top_k=10`、`min_segment_duration=1`、`min_segment_matches=3`、`offset_tolerance_sec=3`、`candidate_limit=0`、`compare_workers=1`、`early_stop=false`，设备为 CPU，并跳过 stream validation。它们只属于本次开发基线，不能修改或代表 production defaults；production 默认值保持不变，CUDA 也未在本轮验证。

真实 CLI 评估默认 `verify_files=true`，先重新计算 manifest sha256，避免同路径素材被替换后仍沿用旧标签。离线 refinement 复用输入报告中的 preprocess config；若缺失会在输出中明确记录使用 core 默认配置。输出包含 source SHA、dirty-tree 状态、参数、wall/cpu 时间、处理帧数（若报告提供）和进程 RSS 观测；RSS 是进程生命周期 high-water/采样值，不能当作精确新增占用。refine 输出保留完整报告路径和配置，不修改输入报告。OpenCV 解码的 PTS 属于 best-effort 时间戳；软 wall-clock 超时无法中断已经阻塞的原生 decode 调用，因此资源上限是尽力而为的边界。显式硬上限为：每对视频的 frame attempts 最多 4096、refined coarse segments 最多 64、输入 segment 条目最多 4096；默认配置仍为每对 256 次 attempts、最多 4 个 refined segments。

## 文件 API 和验收边界

本轮文件范围是 `video_sim/evaluation.py`、`scripts/benchmark_round4.py`、`tests/test_evaluation.py`、`tests/test_benchmark_round4.py`，以及本协议和可选 manifest 示例。核心 refinement 由 `video_sim.segment_refiner.RefinementConfig` 与 `refine_segments(...)` 提供，评估层只校验其 proposal 映射，不改变核心实现。单元测试使用纯标注注入和合成区间，明确与真实 E2E 分开，不能用来宣称 candidate recall；至少覆盖最大匹配反例、双侧 IoU 门槛、重复预测、反向方向、缺失 case、坏 schema、零分母、refinement 映射和输入不变性。

## 当前开发验证记录

已完成不依赖模型的验证：

```text
python scripts/benchmark_round4.py --generate-fixtures
pytest -q tests/test_segment_refiner.py tests/test_evaluation.py tests/test_benchmark_round4.py tests/test_round4_refinement_integration.py  # 60 passed
```

生成 smoke 在 `data/upgrade_round4_20260831/fixtures` 产生 9 个视频和 7 个构造标签 case；ffprobe 复核为 base 144 帧/12s、exact/mirror/crop 各 36 帧/3s、short/speed_2x 各 18 帧/1.5s、unrelated/static 两个负例各 144 帧/12s，全部 12fps，manifest sha256 校验通过。CPU CLIP baseline 的报告由主任务单独运行并保存为 `data/upgrade_round4_20260831/baseline_batch.json`；该报告仍需通过本评估入口解读，不能把一次本机观察写成总体准确率或普遍提速。

主任务已用同一冻结 manifest 生成 baseline、v1 prototype 和 v2 报告。baseline coarse 为 TP=3、FP=11、FN=2（5 个正例）。v1 的 copy/mirror refined 都为 TP=2、FP=12、FN=3，因裁剪 proposal 过短导致 IoU 失配，作为原型失败，不能默认开启。v2 copy 的 refined 与 coarse 均为 TP=3、FP=11、FN=2，边界 mean 均为 0.6388889 秒；v2 copy-mirror 的 refined 为 TP=3、FP=11、FN=2，boundary mean=0.4201389 秒、max=1.1666667 秒。其 `verified_copy` 为 TP=1、FP=0、FN=4；唯一 mirror 匹配的 boundary mean=0.09375 秒、max=0.125 秒。真实 batch `on_integration` 与离线 `mirror_v2` 的语义指标一致。refinement 不能找回粗筛阶段漏检的 pair 或区间，因此这些指标只描述已有候选。

默认关闭回归验证显示：`off` 输出与 baseline 在排除顶层完成时间字段后完全相等，且不生成 `segment_refinement` 字段。断点恢复验证为 36/36 pair rows、`pending=0`，全部 pair rows 的规范化 JSON SHA256 均为 `3293228a83fcf5f1bcd1bacd136e83c7c5e4ee65cb42b9497e51851b6ff5a366`。一次性资源探索记录为：copy-v2 wall=2636 ms、cpu=1078 ms、attempts=1152；mirror-v2 wall=3324 ms、cpu=578 ms、attempts=1511。这些是单机单次观察，不能横向比较、概括性能或推导生产吞吐。

即使开发集指标良好，也只说明构造真值上的协议和实现一致性；当前标签仍是 `generated` development evidence，未提供人工 holdout，不能报告真实用户总体准确率。CPU、RSS、wall 和帧数仅作为同机探索性资源观测，不能外推到其他硬件或完整端到端吞吐。CUDA 未验证；OpenCV PTS 仅 best-effort；软超时不能中断阻塞的原生 decode；refinement 不能找回 coarse 阶段漏检；v2 只允许扩展或覆盖 coarse 区间，不自动裁剪。
