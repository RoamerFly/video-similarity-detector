export type ResizeMode = 'center_crop' | 'letterbox'
export type DeviceMode = 'cpu' | 'cuda' | 'auto'
export type PortraitRotation = 'left_90' | 'right_90'
export type AnalysisMode = 'video_similarity' | 'duplicate_file'
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
}

export interface SettingsSnapshot {
  pythonPath: string
  projectRoot: string
  videoDir: string
  cacheDir: string
  reportDir: string
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
  defaultDevice: DeviceMode
  errorTolerancePreset: ErrorTolerancePreset
  errorToleranceSevereLimit: number
  errorToleranceMissingPictureLimit: number
  errorTolerancePreflightValidation: boolean
  checkEnvOnStartup: boolean
  openMaximized: boolean
  closeBehavior: CloseBehavior
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
  ...normalAnalysisPreset,
  defaultCompareWorkers: 2,
  errorTolerancePreset: 'balanced',
  errorToleranceSevereLimit: 20,
  errorToleranceMissingPictureLimit: 100,
  errorTolerancePreflightValidation: true,
  checkEnvOnStartup: true,
  openMaximized: true,
  closeBehavior: 'ask',
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
    errorTolerancePreset: settings.errorTolerancePreset,
    errorToleranceSevereLimit: settings.errorToleranceSevereLimit,
    errorToleranceMissingPictureLimit: settings.errorToleranceMissingPictureLimit,
    errorTolerancePreflightValidation: settings.errorTolerancePreflightValidation,
    mode: settings.analysisMode,
  }
}
