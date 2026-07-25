export type ResizeMode = 'center_crop' | 'letterbox'
export type DeviceMode = 'cpu' | 'cuda' | 'auto'
export type PortraitRotation = 'left_90' | 'right_90'
export type AnalysisMode = 'video_similarity' | 'duplicate_file'
export type AppLanguage = 'zh-CN' | 'en-US'
export type ErrorTolerancePreset = 'strict' | 'balanced' | 'lenient' | 'failure_only' | 'custom'
export type BuiltInAnalysisPresetId = 'ultra_fast' | 'fast' | 'normal' | 'precise' | 'perfect'
export type EditableAnalysisPresetId = BuiltInAnalysisPresetId | 'custom'
export type AnalysisPresetId = EditableAnalysisPresetId | 'duplicate_file'
export type CloseBehavior = 'ask' | 'tray' | 'exit'
export type VideoScanFilterKey = 'size' | 'name' | 'duration' | 'resolution' | 'fps' | 'extension'
export type VideoScanSizeUnit = 'B' | 'KB' | 'MB' | 'GB' | 'TB'
export type VideoScanDurationUnit = 'ms' | 'sec' | 'min' | 'hour'
export type VideoScanNumericValue = number | ''
export type VideoScanSortBy = 'name' | 'duration' | 'size' | 'fps' | 'resolution' | 'modified'
export type VideoScanSortDirection = 'asc' | 'desc'

export interface ErrorToleranceConfig {
  errorToleranceSevereLimit: number
  errorToleranceMissingPictureLimit: number
  errorTolerancePreflightValidation: boolean
}

export interface VideoScanFilters {
  enabledKeys: VideoScanFilterKey[]
  minSizeGb: VideoScanNumericValue
  maxSizeGb: VideoScanNumericValue
  sizeUnit: VideoScanSizeUnit
  namePrefixes: string
  nameIncludes: string
  minDurationSec: VideoScanNumericValue
  maxDurationSec: VideoScanNumericValue
  durationUnit: VideoScanDurationUnit
  minWidth: VideoScanNumericValue
  minHeight: VideoScanNumericValue
  maxWidth: VideoScanNumericValue
  maxHeight: VideoScanNumericValue
  minFps: VideoScanNumericValue
  maxFps: VideoScanNumericValue
  extensions: string
  sortBy: VideoScanSortBy
  sortDirection: VideoScanSortDirection
  metadataBatchSize: number
}

export interface SettingsSnapshot {
  pythonPath: string
  projectRoot: string
  videoDir: string
  cacheDir: string
  reportDir: string
  networkProxy: string
  defaultSkipThreshold: number
  defaultMatchThreshold: number
  defaultWindowSize: number
  defaultTopK: number
  defaultCandidateLimit: number
  defaultCompareWorkers: number
  defaultMaxGapSec: number
  defaultFrameStep: number
  defaultMinSegmentDuration: number
  defaultMinSegmentMatches: number
  defaultOffsetTolerance: number
  defaultCropBlackBorders: boolean
  defaultResizeMode: ResizeMode
  defaultInputSize: number
  defaultPortraitRotation: PortraitRotation
  defaultForce: boolean
  defaultEarlyStop: boolean
  defaultDevice: DeviceMode
  errorTolerancePreset: ErrorTolerancePreset
  errorToleranceSevereLimit: number
  errorToleranceMissingPictureLimit: number
  errorTolerancePreflightValidation: boolean
  checkEnvOnStartup: boolean
  openMaximized: boolean
  closeBehavior: CloseBehavior
  appLanguage: AppLanguage
  analysisMode: AnalysisMode
  selectedAnalysisPreset: AnalysisPresetId
  customAnalysisPresetSource: BuiltInAnalysisPresetId
  customAnalysisPresets: Record<EditableAnalysisPresetId, AnalysisPresetConfig>
  customErrorTolerance: ErrorToleranceConfig
  videoScanFilters: VideoScanFilters
}

export interface AnalysisConfig {
  videoDir: string
  outputDir: string
  skipThreshold: number
  matchThreshold: number
  windowSize: number
  topK: number
  candidateLimit: number
  compareWorkers: number
  maxGapSec: number
  frameStep: number
  minSegmentDuration: number
  minSegmentMatches: number
  offsetTolerance: number
  cropBlackBorders: boolean
  resizeMode: ResizeMode
  inputSize: number
  portraitRotation: PortraitRotation
  force: boolean
  earlyStop: boolean
  errorTolerancePreset: ErrorTolerancePreset
  errorToleranceSevereLimit: number
  errorToleranceMissingPictureLimit: number
  errorTolerancePreflightValidation: boolean
  mode: AnalysisMode
}

export type AnalysisPresetConfig = Pick<
  SettingsSnapshot,
  | 'analysisMode'
  | 'defaultSkipThreshold'
  | 'defaultMatchThreshold'
  | 'defaultWindowSize'
  | 'defaultTopK'
  | 'defaultCandidateLimit'
  | 'defaultMaxGapSec'
  | 'defaultFrameStep'
  | 'defaultMinSegmentDuration'
  | 'defaultMinSegmentMatches'
  | 'defaultOffsetTolerance'
  | 'defaultCropBlackBorders'
  | 'defaultResizeMode'
  | 'defaultInputSize'
  | 'defaultPortraitRotation'
  | 'defaultForce'
  | 'defaultEarlyStop'
  | 'defaultDevice'
>

const normalAnalysisPreset: AnalysisPresetConfig = {
  analysisMode: 'video_similarity',
  defaultSkipThreshold: 0.82,
  defaultMatchThreshold: 0.64,
  defaultWindowSize: 60,
  defaultTopK: 5,
  defaultCandidateLimit: 20,
  defaultMaxGapSec: 18,
  defaultFrameStep: 6,
  defaultMinSegmentDuration: 5,
  defaultMinSegmentMatches: 3,
  defaultOffsetTolerance: 3,
  defaultCropBlackBorders: true,
  defaultResizeMode: 'center_crop',
  defaultInputSize: 224,
  defaultPortraitRotation: 'right_90',
  defaultForce: false,
  defaultEarlyStop: true,
  defaultDevice: 'auto',
}

export const analysisPresets: Record<AnalysisPresetId, AnalysisPresetConfig> = {
  ultra_fast: {
    ...normalAnalysisPreset,
    defaultSkipThreshold: 0.6,
    defaultMatchThreshold: 0.58,
    defaultWindowSize: 180,
    defaultTopK: 1,
    defaultCandidateLimit: 6,
    defaultMaxGapSec: 45,
    defaultFrameStep: 30,
    defaultMinSegmentDuration: 12,
    defaultMinSegmentMatches: 2,
    defaultOffsetTolerance: 8,
    defaultInputSize: 128,
  },
  fast: {
    ...normalAnalysisPreset,
    defaultSkipThreshold: 0.7,
    defaultMatchThreshold: 0.6,
    defaultWindowSize: 120,
    defaultTopK: 2,
    defaultCandidateLimit: 10,
    defaultMaxGapSec: 30,
    defaultFrameStep: 16,
    defaultMinSegmentDuration: 8,
    defaultMinSegmentMatches: 2,
    defaultOffsetTolerance: 5,
    defaultInputSize: 160,
  },
  normal: normalAnalysisPreset,
  precise: {
    ...normalAnalysisPreset,
    defaultSkipThreshold: 0.92,
    defaultMatchThreshold: 0.68,
    defaultWindowSize: 30,
    defaultTopK: 10,
    defaultCandidateLimit: 40,
    defaultMaxGapSec: 8,
    defaultFrameStep: 3,
    defaultMinSegmentDuration: 3,
    defaultMinSegmentMatches: 3,
    defaultOffsetTolerance: 2,
    defaultInputSize: 256,
  },
  perfect: {
    ...normalAnalysisPreset,
    defaultSkipThreshold: 0.98,
    defaultMatchThreshold: 0.72,
    defaultWindowSize: 15,
    defaultTopK: 24,
    defaultCandidateLimit: 0,
    defaultMaxGapSec: 3,
    defaultFrameStep: 1,
    defaultMinSegmentDuration: 2,
    defaultMinSegmentMatches: 2,
    defaultOffsetTolerance: 1,
    defaultInputSize: 384,
  },
  duplicate_file: {
    ...normalAnalysisPreset,
    analysisMode: 'duplicate_file',
  },
  custom: {
    ...normalAnalysisPreset,
  },
}

export const analysisPresetOptions: Array<{
  id: AnalysisPresetId
  name: string
  description: string
  summary: string
  tip: string
}> = [
  {
    id: 'ultra_fast',
    name: '极速',
    description: '极限压缩抽帧和匹配量，只做粗筛。',
    summary: '粗筛 6 / 步长 30 / Top-K 1',
    tip: '极速：每 30 帧看一次，画面相似就大量跳过，只适合从海量视频中快速找明显重复。',
  },
  {
    id: 'fast',
    name: '快速',
    description: '优先速度，适合大量视频初筛。',
    summary: '粗筛 10 / 步长 16 / Top-K 2',
    tip: '快速：比极速多保留一些变化画面，适合大批量视频的第一轮筛查。',
  },
  {
    id: 'normal',
    name: '普通',
    description: '速度和准确度均衡，适合日常分析。',
    summary: '粗筛 20 / 步长 6 / Top-K 5',
    tip: '普通：默认推荐配置，保留关键变化画面，同时避免长视频逐帧处理。',
  },
  {
    id: 'precise',
    name: '精确',
    description: '保留更多细节，适合最终确认。',
    summary: '粗筛 40 / 步长 3 / Top-K 10',
    tip: '精确：更密集地检查画面变化，并提高候选数量，适合对疑似重复视频复核。',
  },
  {
    id: 'perfect',
    name: '完美',
    description: '尽量追求准确，耗时最高。',
    summary: '全部比较 / 步长 1 / Top-K 24',
    tip: '完美：逐帧检查并使用最高候选量，适合少量关键视频的最终核验。',
  },
  {
    id: 'custom',
    name: '自定义',
    description: '保存你临时调整后的参数。',
    summary: '用户自定义参数',
    tip: '自定义：选择任意预设后修改参数，都会先保存到这里；点击“保存到当前来源预设”才会覆盖对应预设。',
  },
  {
    id: 'duplicate_file',
    name: '对比相同文件',
    description: '只查文件内容是否完全一致。',
    summary: '不抽帧 / 不用 GPU / 不跑分析程序',
    tip: '对比相同文件：直接扫描相同大小的视频并计算文件指纹，只判断是不是完全同一个文件，不进行抽帧和相似度分析。',
  },
]

export const errorToleranceOptions: Array<{
  id: ErrorTolerancePreset
  name: string
  description: string
  effect: string
}> = [
  {
    id: 'strict',
    name: '严格',
    description: '连续 5 条严重码流错误或 20 条缺失画面即隔离。',
    effect: '结果最干净，但部分还能播放的视频可能被移出。',
  },
  {
    id: 'balanced',
    name: '标准',
    description: '连续 20 条严重错误或 100 条缺失画面才隔离。',
    effect: '推荐设置，在完整性和可用性之间保持平衡。',
  },
  {
    id: 'lenient',
    name: '宽松',
    description: '允许最多 200 条严重错误或 1000 条缺失画面。',
    effect: '尽量保留可播放视频，少量画面可能被跳过。',
  },
  {
    id: 'failure_only',
    name: '仅失败时',
    description: '忽略可恢复码流告警，只在无法打开或抽不出有效画面时隔离。',
    effect: '容忍度最高，适合视觉影响不明显的视频库。',
  },
  {
    id: 'custom',
    name: '自定义',
    description: '使用手动调整后的错误容忍数值。',
    effect: '选择任意容忍预设后修改数值，会先保存到这里。',
  },
]

export function cloneEditableAnalysisPresets(
  source: Partial<Record<EditableAnalysisPresetId, AnalysisPresetConfig>> = analysisPresets,
): Record<EditableAnalysisPresetId, AnalysisPresetConfig> {
  return {
    ultra_fast: { ...analysisPresets.ultra_fast, ...source.ultra_fast },
    fast: { ...analysisPresets.fast, ...source.fast },
    normal: { ...analysisPresets.normal, ...source.normal },
    precise: { ...analysisPresets.precise, ...source.precise },
    perfect: { ...analysisPresets.perfect, ...source.perfect },
    custom: { ...analysisPresets.custom, ...source.custom },
  }
}

export const defaultSettings: SettingsSnapshot = {
  pythonPath: 'python',
  projectRoot: '',
  videoDir: '',
  cacheDir: 'data',
  reportDir: 'data/reports',
  networkProxy: '',
  ...normalAnalysisPreset,
  defaultCompareWorkers: 2,
  errorTolerancePreset: 'balanced',
  errorToleranceSevereLimit: 20,
  errorToleranceMissingPictureLimit: 100,
  errorTolerancePreflightValidation: true,
  checkEnvOnStartup: true,
  openMaximized: true,
  closeBehavior: 'ask',
  appLanguage: 'zh-CN',
  selectedAnalysisPreset: 'normal',
  customAnalysisPresetSource: 'normal',
  customAnalysisPresets: cloneEditableAnalysisPresets(),
  customErrorTolerance: {
    errorToleranceSevereLimit: 20,
    errorToleranceMissingPictureLimit: 100,
    errorTolerancePreflightValidation: true,
  },
  videoScanFilters: {
    enabledKeys: [],
    minSizeGb: 0,
    maxSizeGb: 0,
    sizeUnit: 'GB',
    namePrefixes: '',
    nameIncludes: '',
    minDurationSec: 0,
    maxDurationSec: 0,
    durationUnit: 'sec',
    minWidth: 0,
    minHeight: 0,
    maxWidth: 0,
    maxHeight: 0,
    minFps: 0,
    maxFps: 0,
    extensions: '',
    sortBy: 'name',
    sortDirection: 'asc',
    metadataBatchSize: 50,
  },
}

export function analysisConfigFromSettings(settings: SettingsSnapshot): AnalysisConfig {
  return {
    videoDir: settings.videoDir,
    outputDir: settings.reportDir,
    skipThreshold: settings.defaultSkipThreshold,
    matchThreshold: settings.defaultMatchThreshold,
    windowSize: settings.defaultWindowSize,
    topK: settings.defaultTopK,
    candidateLimit: settings.defaultCandidateLimit,
    compareWorkers: settings.defaultCompareWorkers,
    maxGapSec: settings.defaultMaxGapSec,
    frameStep: settings.defaultFrameStep,
    minSegmentDuration: settings.defaultMinSegmentDuration,
    minSegmentMatches: settings.defaultMinSegmentMatches,
    offsetTolerance: settings.defaultOffsetTolerance,
    cropBlackBorders: settings.defaultCropBlackBorders,
    resizeMode: settings.defaultResizeMode,
    inputSize: settings.defaultInputSize,
    portraitRotation: settings.defaultPortraitRotation,
    force: settings.defaultForce,
    earlyStop: settings.defaultEarlyStop,
    errorTolerancePreset: settings.errorTolerancePreset,
    errorToleranceSevereLimit: settings.errorToleranceSevereLimit,
    errorToleranceMissingPictureLimit: settings.errorToleranceMissingPictureLimit,
    errorTolerancePreflightValidation: settings.errorTolerancePreflightValidation,
    mode: settings.analysisMode,
  }
}
