import { create } from 'zustand'
import type {
  AnalysisMode,
  AnalysisPresetConfig,
  AnalysisPresetId,
  BuiltInAnalysisPresetId,
  CloseBehavior,
  DeviceMode,
  EditableAnalysisPresetId,
  ErrorTolerancePreset,
  PortraitRotation,
  ResizeMode,
  SettingsSnapshot,
} from '@/types/config'
import { analysisPresets, cloneEditableAnalysisPresets, defaultSettings } from '@/types/config'

interface SettingsActions {
  setPythonPath: (path: string) => void
  setProjectRoot: (path: string) => void
  setVideoDir: (dir: string) => void
  setCacheDir: (dir: string) => void
  setReportDir: (dir: string) => void
  setDefaultSkipThreshold: (value: number) => void
  setDefaultMatchThreshold: (value: number) => void
  setDefaultWindowSize: (value: number) => void
  setDefaultTopK: (value: number) => void
  setDefaultCandidateLimit: (value: number) => void
  setDefaultCompareWorkers: (value: number) => void
  setDefaultMaxGapSec: (value: number) => void
  setDefaultFrameStep: (value: number) => void
  setDefaultMinSegmentDuration: (value: number) => void
  setDefaultMinSegmentMatches: (value: number) => void
  setDefaultOffsetTolerance: (value: number) => void
  setDefaultCropBlackBorders: (value: boolean) => void
  setDefaultResizeMode: (value: ResizeMode) => void
  setDefaultInputSize: (value: number) => void
  setDefaultPortraitRotation: (value: PortraitRotation) => void
  setDefaultForce: (value: boolean) => void
  setDefaultDevice: (value: DeviceMode) => void
  setErrorTolerancePreset: (value: ErrorTolerancePreset) => void
  setErrorToleranceSevereLimit: (value: number) => void
  setErrorToleranceMissingPictureLimit: (value: number) => void
  setErrorTolerancePreflightValidation: (value: boolean) => void
  applyErrorToleranceTemplate: (config: {
    errorTolerancePreset: ErrorTolerancePreset
    errorToleranceSevereLimit: number
    errorToleranceMissingPictureLimit: number
    errorTolerancePreflightValidation: boolean
  }) => void
  setCheckEnvOnStartup: (value: boolean) => void
  setOpenMaximized: (value: boolean) => void
  setCloseBehavior: (value: CloseBehavior) => void
  setAnalysisMode: (value: AnalysisMode) => void
  applyAnalysisPreset: (preset: AnalysisPresetId) => void
  applyAnalysisTemplate: (config: AnalysisPresetConfig) => void
  saveCurrentAnalysisPreset: () => void
  hydrateAppDefaults: (defaults: Partial<Pick<SettingsSnapshot, 'projectRoot' | 'videoDir' | 'cacheDir' | 'reportDir'>>) => void
  resetBaseSettings: (defaults?: Partial<Pick<SettingsSnapshot, 'projectRoot' | 'videoDir' | 'cacheDir' | 'reportDir'>>) => void
  resetAnalysisSettings: () => void
  resetErrorToleranceSettings: () => void
  resetSettings: () => void
  saveSettings: () => void
  replaceSettings: (settings: SettingsSnapshot) => void
}

export type SettingsState = SettingsSnapshot & SettingsActions

const SETTINGS_STORAGE_KEY = 'video-similarity-settings'

export const useSettingsStore = create<SettingsState>()(
  (set) => {
    const updateAnalysis = (patch: Partial<AnalysisPresetConfig>) =>
      set((state) => applyAnalysisPatch(state, patch))

    return {
      ...defaultSettings,
      ...readPersistedSettings(),

      setPythonPath: (pythonPath) => set({ pythonPath: normalizePathForDisplay(pythonPath) }),
      setProjectRoot: (projectRoot) => set({ projectRoot: normalizePathForDisplay(projectRoot) }),
      setVideoDir: (videoDir) => set({ videoDir: normalizePathForDisplay(videoDir) }),
      setCacheDir: (cacheDir) => set({ cacheDir: normalizePathForDisplay(cacheDir) }),
      setReportDir: (reportDir) => set({ reportDir: normalizePathForDisplay(reportDir) }),
      setDefaultSkipThreshold: (defaultSkipThreshold) => updateAnalysis({ defaultSkipThreshold }),
      setDefaultMatchThreshold: (defaultMatchThreshold) => updateAnalysis({
        defaultMatchThreshold: clampFloat(defaultMatchThreshold, 0.3, 0.99),
      }),
      setDefaultWindowSize: (defaultWindowSize) => updateAnalysis({ defaultWindowSize }),
      setDefaultTopK: (defaultTopK) => updateAnalysis({ defaultTopK }),
      setDefaultCandidateLimit: (defaultCandidateLimit) => updateAnalysis({
        defaultCandidateLimit: clampMin(defaultCandidateLimit, 0),
      }),
      setDefaultCompareWorkers: (defaultCompareWorkers) => set({
        defaultCompareWorkers: clampMin(defaultCompareWorkers, 1),
      }),
      setDefaultMaxGapSec: (defaultMaxGapSec) => updateAnalysis({ defaultMaxGapSec }),
      setDefaultFrameStep: (defaultFrameStep) => updateAnalysis({ defaultFrameStep: clampMin(defaultFrameStep, 1) }),
      setDefaultMinSegmentDuration: (defaultMinSegmentDuration) => updateAnalysis({ defaultMinSegmentDuration: clampMin(defaultMinSegmentDuration, 1) }),
      setDefaultMinSegmentMatches: (defaultMinSegmentMatches) => updateAnalysis({ defaultMinSegmentMatches: clampMin(defaultMinSegmentMatches, 1) }),
      setDefaultOffsetTolerance: (defaultOffsetTolerance) => updateAnalysis({ defaultOffsetTolerance: clampMin(defaultOffsetTolerance, 1) }),
      setDefaultCropBlackBorders: (defaultCropBlackBorders) => updateAnalysis({ defaultCropBlackBorders }),
      setDefaultResizeMode: (defaultResizeMode) => updateAnalysis({ defaultResizeMode }),
      setDefaultInputSize: (defaultInputSize) => updateAnalysis({ defaultInputSize }),
      setDefaultPortraitRotation: (defaultPortraitRotation) => updateAnalysis({ defaultPortraitRotation }),
      setDefaultForce: (defaultForce) => updateAnalysis({ defaultForce }),
      setDefaultDevice: (defaultDevice) => updateAnalysis({ defaultDevice }),
      setErrorTolerancePreset: (errorTolerancePreset) => set((state) => {
        if (errorTolerancePreset === 'custom') {
          return {
            errorTolerancePreset: 'custom',
            ...state.customErrorTolerance,
          }
        }
        return {
          errorTolerancePreset,
          ...errorToleranceValues(errorTolerancePreset),
        }
      }),
      setErrorToleranceSevereLimit: (errorToleranceSevereLimit) => set((state) => {
        const next = clampMin(errorToleranceSevereLimit, 0)
        const customErrorTolerance = {
          errorToleranceMissingPictureLimit: state.errorToleranceMissingPictureLimit,
          errorTolerancePreflightValidation: state.errorTolerancePreflightValidation,
          errorToleranceSevereLimit: next,
        }
        return {
          errorTolerancePreset: 'custom',
          errorToleranceSevereLimit: next,
          customErrorTolerance,
        }
      }),
      setErrorToleranceMissingPictureLimit: (errorToleranceMissingPictureLimit) => set((state) => {
        const next = clampMin(errorToleranceMissingPictureLimit, 0)
        const customErrorTolerance = {
          errorToleranceSevereLimit: state.errorToleranceSevereLimit,
          errorTolerancePreflightValidation: state.errorTolerancePreflightValidation,
          errorToleranceMissingPictureLimit: next,
        }
        return {
          errorTolerancePreset: 'custom',
          errorToleranceMissingPictureLimit: next,
          customErrorTolerance,
        }
      }),
      setErrorTolerancePreflightValidation: (errorTolerancePreflightValidation) => set((state) => {
        const customErrorTolerance = {
          errorToleranceSevereLimit: state.errorToleranceSevereLimit,
          errorToleranceMissingPictureLimit: state.errorToleranceMissingPictureLimit,
          errorTolerancePreflightValidation,
        }
        return {
          errorTolerancePreset: 'custom',
          errorTolerancePreflightValidation,
          customErrorTolerance,
        }
      }),
      applyErrorToleranceTemplate: (config) => set((state) => {
        const preset = sanitizeErrorTolerancePreset(config.errorTolerancePreset)
        const values = sanitizeErrorToleranceValues(config, state.customErrorTolerance)
        if (preset === 'custom') {
          return {
            errorTolerancePreset: 'custom',
            ...values,
            customErrorTolerance: values,
          }
        }
        return {
          errorTolerancePreset: preset,
          ...errorToleranceValues(preset),
        }
      }),
      setCheckEnvOnStartup: (checkEnvOnStartup) => set({ checkEnvOnStartup }),
      setOpenMaximized: (openMaximized) => set({ openMaximized }),
      setCloseBehavior: (closeBehavior) => set({ closeBehavior }),
      setAnalysisMode: (analysisMode) => set({
        analysisMode,
        selectedAnalysisPreset: analysisMode === 'duplicate_file' ? 'duplicate_file' : 'normal',
        customAnalysisPresetSource: 'normal',
      }),
      applyAnalysisPreset: (preset) =>
        set((state) => {
          if (preset === 'duplicate_file') {
            return {
              ...analysisPresets.duplicate_file,
              selectedAnalysisPreset: preset,
            }
          }
          if (preset === 'custom') {
            return {
              ...state.customAnalysisPresets.custom,
              analysisMode: 'video_similarity',
              selectedAnalysisPreset: 'custom',
            }
          }
          return {
            ...state.customAnalysisPresets[preset],
            analysisMode: 'video_similarity',
            selectedAnalysisPreset: preset,
            customAnalysisPresetSource: preset,
          }
        }),
      applyAnalysisTemplate: (config) =>
        set((state) => {
          const sanitized = sanitizeNamedAnalysisTemplate(config)
          return {
            ...sanitized,
            analysisMode: 'video_similarity',
            selectedAnalysisPreset: 'custom',
            customAnalysisPresetSource: resolveCustomAnalysisSource(state),
            customAnalysisPresets: {
              ...state.customAnalysisPresets,
              custom: sanitized,
            },
          }
        }),
      saveCurrentAnalysisPreset: () =>
        set((state) => {
          if (state.selectedAnalysisPreset === 'duplicate_file') return state
          const presetId = state.selectedAnalysisPreset === 'custom'
            ? state.customAnalysisPresetSource
            : state.selectedAnalysisPreset
          return {
            selectedAnalysisPreset: presetId,
            customAnalysisPresetSource: presetId,
            customAnalysisPresets: {
              ...state.customAnalysisPresets,
              [presetId]: analysisPresetFromSettings(state),
            },
          }
        }),
      hydrateAppDefaults: (defaults) =>
        set((state) => ({
          projectRoot: normalizePathForDisplay(defaults.projectRoot || state.projectRoot || ''),
          videoDir: shouldUseDefaultPath(state.videoDir, defaultSettings.videoDir, state.projectRoot, 'videos')
            ? normalizePathForDisplay(defaults.videoDir || state.videoDir)
            : normalizePathForDisplay(state.videoDir),
          cacheDir: shouldUseDefaultPath(state.cacheDir, defaultSettings.cacheDir, state.projectRoot, 'data')
            ? normalizePathForDisplay(defaults.cacheDir || state.cacheDir)
            : normalizePathForDisplay(state.cacheDir),
          reportDir: shouldUseDefaultPath(state.reportDir, defaultSettings.reportDir, state.projectRoot, 'data/reports')
            ? normalizePathForDisplay(defaults.reportDir || state.reportDir)
            : normalizePathForDisplay(state.reportDir),
        })),
      resetBaseSettings: (defaults) =>
        set({
          pythonPath: defaultSettings.pythonPath,
          projectRoot: normalizePathForDisplay(defaults?.projectRoot || defaultSettings.projectRoot),
          videoDir: normalizePathForDisplay(defaults?.videoDir || defaultSettings.videoDir),
          cacheDir: normalizePathForDisplay(defaults?.cacheDir || defaultSettings.cacheDir),
          reportDir: normalizePathForDisplay(defaults?.reportDir || defaultSettings.reportDir),
          checkEnvOnStartup: defaultSettings.checkEnvOnStartup,
          openMaximized: defaultSettings.openMaximized,
          closeBehavior: defaultSettings.closeBehavior,
          defaultCompareWorkers: defaultSettings.defaultCompareWorkers,
        }),
      resetAnalysisSettings: () =>
        set((state) => {
          const presetId = state.selectedAnalysisPreset === 'duplicate_file'
            ? 'normal'
            : state.selectedAnalysisPreset === 'custom'
              ? state.customAnalysisPresetSource
              : state.selectedAnalysisPreset
          const builtInPreset = analysisPresets[presetId]
          return {
            ...builtInPreset,
            selectedAnalysisPreset: presetId,
            customAnalysisPresetSource: presetId,
            customAnalysisPresets: {
              ...state.customAnalysisPresets,
              [presetId]: { ...builtInPreset },
            },
          }
        }),
      resetErrorToleranceSettings: () => set({
        errorTolerancePreset: defaultSettings.errorTolerancePreset,
        errorToleranceSevereLimit: defaultSettings.errorToleranceSevereLimit,
        errorToleranceMissingPictureLimit: defaultSettings.errorToleranceMissingPictureLimit,
        errorTolerancePreflightValidation: defaultSettings.errorTolerancePreflightValidation,
      }),
      resetSettings: () => set({
        ...defaultSettings,
        customAnalysisPresets: cloneEditableAnalysisPresets(),
        customErrorTolerance: { ...defaultSettings.customErrorTolerance },
      }),
      saveSettings: () => persistSettingsSnapshot(settingsSnapshotFromState(useSettingsStore.getState())),
      replaceSettings: (settings) => set(settingsSnapshotFromState(settings)),
    }
  },
)

export function settingsSnapshotFromState(settings: SettingsSnapshot): SettingsSnapshot {
  return {
    pythonPath: settings.pythonPath,
    projectRoot: settings.projectRoot,
    videoDir: settings.videoDir,
    cacheDir: settings.cacheDir,
    reportDir: settings.reportDir,
    defaultSkipThreshold: settings.defaultSkipThreshold,
    defaultMatchThreshold: settings.defaultMatchThreshold,
    defaultWindowSize: settings.defaultWindowSize,
    defaultTopK: settings.defaultTopK,
    defaultCandidateLimit: settings.defaultCandidateLimit,
    defaultCompareWorkers: settings.defaultCompareWorkers,
    defaultMaxGapSec: settings.defaultMaxGapSec,
    defaultFrameStep: settings.defaultFrameStep,
    defaultMinSegmentDuration: settings.defaultMinSegmentDuration,
    defaultMinSegmentMatches: settings.defaultMinSegmentMatches,
    defaultOffsetTolerance: settings.defaultOffsetTolerance,
    defaultCropBlackBorders: settings.defaultCropBlackBorders,
    defaultResizeMode: settings.defaultResizeMode,
    defaultInputSize: settings.defaultInputSize,
    defaultPortraitRotation: settings.defaultPortraitRotation,
    defaultForce: settings.defaultForce,
    defaultDevice: settings.defaultDevice,
    errorTolerancePreset: settings.errorTolerancePreset,
    errorToleranceSevereLimit: settings.errorToleranceSevereLimit,
    errorToleranceMissingPictureLimit: settings.errorToleranceMissingPictureLimit,
    errorTolerancePreflightValidation: settings.errorTolerancePreflightValidation,
    checkEnvOnStartup: settings.checkEnvOnStartup,
    openMaximized: settings.openMaximized,
    closeBehavior: settings.closeBehavior,
    analysisMode: settings.analysisMode,
    selectedAnalysisPreset: settings.selectedAnalysisPreset,
    customAnalysisPresetSource: settings.customAnalysisPresetSource,
    customAnalysisPresets: cloneEditableAnalysisPresets(settings.customAnalysisPresets),
    customErrorTolerance: { ...settings.customErrorTolerance },
  }
}

function readPersistedSettings(): Partial<SettingsSnapshot> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { state?: unknown } | unknown
    const persisted = parsed && typeof parsed === 'object' && 'state' in parsed
      ? parsed.state
      : parsed
    return sanitizePersistedSettings(persisted)
  } catch {
    return {}
  }
}

function persistSettingsSnapshot(settings: SettingsSnapshot) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
    state: settingsSnapshotFromState(settings),
    version: 0,
  }))
}

function applyAnalysisPatch(
  state: SettingsState,
  patch: Partial<AnalysisPresetConfig>,
): Partial<SettingsSnapshot> {
  const sourcePreset = resolveCustomAnalysisSource(state)
  const nextSettings = {
    ...state,
    ...patch,
    analysisMode: 'video_similarity' as const,
    selectedAnalysisPreset: 'custom' as const,
    customAnalysisPresetSource: sourcePreset,
  }
  return {
    ...patch,
    analysisMode: 'video_similarity',
    selectedAnalysisPreset: 'custom',
    customAnalysisPresetSource: sourcePreset,
    customAnalysisPresets: {
      ...state.customAnalysisPresets,
      custom: analysisPresetFromSettings(nextSettings),
    },
  }
}

function resolveCustomAnalysisSource(state: Pick<SettingsSnapshot, 'selectedAnalysisPreset' | 'customAnalysisPresetSource'>): BuiltInAnalysisPresetId {
  if (state.selectedAnalysisPreset !== 'duplicate_file' && state.selectedAnalysisPreset !== 'custom') {
    return state.selectedAnalysisPreset
  }
  return sanitizeBuiltInPresetId(state.customAnalysisPresetSource)
}

function shouldUseDefaultPath(current: string, defaultPath: string, previousRoot: string, defaultChild: string) {
  const normalized = normalizeComparablePath(current)
  if (!normalized) return true

  const normalizedDefault = normalizeComparablePath(defaultPath)
  if (
    normalized === normalizedDefault ||
    normalized === normalizeComparablePath(`./${defaultPath}`) ||
    normalized === normalizeComparablePath(defaultPath.replaceAll('/', '\\'))
  ) {
    return true
  }

  if (!previousRoot) return false
  return normalized === normalizeComparablePath(`${previousRoot}/${defaultChild}`)
}

function sanitizePersistedSettings(value: unknown): Partial<SettingsSnapshot> {
  if (!value || typeof value !== 'object') return {}
  const snapshot = value as Partial<SettingsSnapshot>
  const resizeMode: ResizeMode = snapshot.defaultResizeMode === 'letterbox' ? 'letterbox' : defaultSettings.defaultResizeMode
  const portraitRotation: PortraitRotation = snapshot.defaultPortraitRotation === 'left_90'
    ? 'left_90'
    : defaultSettings.defaultPortraitRotation
  const inputSize = Number(snapshot.defaultInputSize)
  const matchThreshold = Number(snapshot.defaultMatchThreshold)
  const frameStep = Number(snapshot.defaultFrameStep)
  const minSegmentDuration = Number(snapshot.defaultMinSegmentDuration)
  const minSegmentMatches = Number(snapshot.defaultMinSegmentMatches)
  const offsetTolerance = Number(snapshot.defaultOffsetTolerance)
  const candidateLimit = Number(snapshot.defaultCandidateLimit)
  const compareWorkers = Number(snapshot.defaultCompareWorkers)
  const legacyCloseToBackground = (snapshot as { closeToBackground?: unknown }).closeToBackground
  const closeBehavior: CloseBehavior = snapshot.closeBehavior === 'tray' || snapshot.closeBehavior === 'exit' || snapshot.closeBehavior === 'ask'
    ? snapshot.closeBehavior
    : legacyCloseToBackground === true
      ? 'tray'
      : defaultSettings.closeBehavior
  const errorTolerancePreset: ErrorTolerancePreset =
    snapshot.errorTolerancePreset === 'strict'
    || snapshot.errorTolerancePreset === 'lenient'
    || snapshot.errorTolerancePreset === 'failure_only'
    || snapshot.errorTolerancePreset === 'balanced'
    || snapshot.errorTolerancePreset === 'custom'
      ? snapshot.errorTolerancePreset
      : defaultSettings.errorTolerancePreset
  const severeLimit = Number(snapshot.errorToleranceSevereLimit)
  const missingPictureLimit = Number(snapshot.errorToleranceMissingPictureLimit)
  const customErrorTolerance = sanitizeErrorToleranceValues(
    (snapshot as Partial<SettingsSnapshot>).customErrorTolerance ?? snapshot,
    defaultSettings.customErrorTolerance,
  )

  return {
    ...snapshot,
    pythonPath: normalizePathForDisplay(snapshot.pythonPath ?? defaultSettings.pythonPath),
    projectRoot: normalizePathForDisplay(snapshot.projectRoot ?? defaultSettings.projectRoot),
    videoDir: normalizePathForDisplay(snapshot.videoDir ?? defaultSettings.videoDir),
    cacheDir: normalizePathForDisplay(snapshot.cacheDir ?? defaultSettings.cacheDir),
    reportDir: normalizePathForDisplay(snapshot.reportDir ?? defaultSettings.reportDir),
    defaultResizeMode: resizeMode,
    defaultMatchThreshold: Number.isFinite(matchThreshold)
      ? clampFloat(matchThreshold, 0.3, 0.99)
      : defaultSettings.defaultMatchThreshold,
    defaultInputSize: Number.isFinite(inputSize) ? clampMin(inputSize, 1) : defaultSettings.defaultInputSize,
    defaultFrameStep: Number.isFinite(frameStep) ? clampMin(frameStep, 1) : defaultSettings.defaultFrameStep,
    defaultCandidateLimit: Number.isFinite(candidateLimit) ? clampMin(candidateLimit, 0) : defaultSettings.defaultCandidateLimit,
    defaultCompareWorkers: Number.isFinite(compareWorkers) ? clampMin(compareWorkers, 1) : defaultSettings.defaultCompareWorkers,
    defaultMinSegmentDuration: Number.isFinite(minSegmentDuration) ? clampMin(minSegmentDuration, 1) : defaultSettings.defaultMinSegmentDuration,
    defaultMinSegmentMatches: Number.isFinite(minSegmentMatches) ? clampMin(minSegmentMatches, 1) : defaultSettings.defaultMinSegmentMatches,
    defaultOffsetTolerance: Number.isFinite(offsetTolerance) ? clampMin(offsetTolerance, 1) : defaultSettings.defaultOffsetTolerance,
    defaultPortraitRotation: portraitRotation,
    closeBehavior,
    errorTolerancePreset,
    errorToleranceSevereLimit: Number.isFinite(severeLimit)
      ? clampMin(severeLimit, 0)
      : errorToleranceValues(errorTolerancePreset).errorToleranceSevereLimit,
    errorToleranceMissingPictureLimit: Number.isFinite(missingPictureLimit)
      ? clampMin(missingPictureLimit, 0)
      : errorToleranceValues(errorTolerancePreset).errorToleranceMissingPictureLimit,
    errorTolerancePreflightValidation: typeof snapshot.errorTolerancePreflightValidation === 'boolean'
      ? snapshot.errorTolerancePreflightValidation
      : defaultSettings.errorTolerancePreflightValidation,
    analysisMode: snapshot.analysisMode === 'duplicate_file' ? 'duplicate_file' : defaultSettings.analysisMode,
    selectedAnalysisPreset: sanitizePresetId(snapshot.selectedAnalysisPreset),
    customAnalysisPresetSource: sanitizeBuiltInPresetId(snapshot.customAnalysisPresetSource),
    customAnalysisPresets: sanitizeCustomAnalysisPresets(snapshot.customAnalysisPresets),
    customErrorTolerance,
  }
}

export function analysisPresetFromSettings(settings: SettingsSnapshot): AnalysisPresetConfig {
  return {
    analysisMode: 'video_similarity',
    defaultSkipThreshold: settings.defaultSkipThreshold,
    defaultMatchThreshold: settings.defaultMatchThreshold,
    defaultWindowSize: settings.defaultWindowSize,
    defaultTopK: settings.defaultTopK,
    defaultCandidateLimit: settings.defaultCandidateLimit,
    defaultMaxGapSec: settings.defaultMaxGapSec,
    defaultFrameStep: settings.defaultFrameStep,
    defaultMinSegmentDuration: settings.defaultMinSegmentDuration,
    defaultMinSegmentMatches: settings.defaultMinSegmentMatches,
    defaultOffsetTolerance: settings.defaultOffsetTolerance,
    defaultCropBlackBorders: settings.defaultCropBlackBorders,
    defaultResizeMode: settings.defaultResizeMode,
    defaultInputSize: settings.defaultInputSize,
    defaultPortraitRotation: settings.defaultPortraitRotation,
    defaultForce: settings.defaultForce,
    defaultDevice: settings.defaultDevice,
  }
}

function sanitizeNamedAnalysisTemplate(config: AnalysisPresetConfig): AnalysisPresetConfig {
  const merged = { ...analysisPresets.normal, ...config }
  return {
    ...merged,
    analysisMode: 'video_similarity',
    defaultMatchThreshold: clampFloat(Number(merged.defaultMatchThreshold), 0.3, 0.99),
    defaultCandidateLimit: clampMin(Number(merged.defaultCandidateLimit), 0),
    defaultFrameStep: clampMin(Number(merged.defaultFrameStep), 1),
    defaultMinSegmentDuration: clampMin(Number(merged.defaultMinSegmentDuration), 1),
    defaultMinSegmentMatches: clampMin(Number(merged.defaultMinSegmentMatches), 1),
    defaultOffsetTolerance: clampMin(Number(merged.defaultOffsetTolerance), 1),
    defaultInputSize: clampMin(Number(merged.defaultInputSize), 1),
  }
}

function sanitizePresetId(value: unknown): AnalysisPresetId {
  return value === 'ultra_fast' || value === 'fast' || value === 'normal' || value === 'precise' || value === 'perfect' || value === 'custom' || value === 'duplicate_file'
    ? value
    : defaultSettings.selectedAnalysisPreset
}

function sanitizeBuiltInPresetId(value: unknown): BuiltInAnalysisPresetId {
  return value === 'ultra_fast' || value === 'fast' || value === 'normal' || value === 'precise' || value === 'perfect'
    ? value
    : defaultSettings.customAnalysisPresetSource
}

function sanitizeCustomAnalysisPresets(value: unknown) {
  if (!value || typeof value !== 'object') return cloneEditableAnalysisPresets()
  const raw = value as Partial<Record<EditableAnalysisPresetId, Partial<AnalysisPresetConfig>>>
  const sanitized = cloneEditableAnalysisPresets()
  for (const presetId of ['ultra_fast', 'fast', 'normal', 'precise', 'perfect', 'custom'] as const) {
    const candidate = raw[presetId]
    if (!candidate || typeof candidate !== 'object') continue
    const merged = { ...analysisPresets[presetId], ...candidate }
    sanitized[presetId] = {
      ...merged,
      analysisMode: 'video_similarity',
      defaultMatchThreshold: clampFloat(Number(merged.defaultMatchThreshold), 0.3, 0.99),
      defaultCandidateLimit: clampMin(Number(merged.defaultCandidateLimit), 0),
      defaultFrameStep: clampMin(Number(merged.defaultFrameStep), 1),
      defaultMinSegmentDuration: clampMin(Number(merged.defaultMinSegmentDuration), 1),
      defaultMinSegmentMatches: clampMin(Number(merged.defaultMinSegmentMatches), 1),
      defaultOffsetTolerance: clampMin(Number(merged.defaultOffsetTolerance), 1),
      defaultInputSize: clampMin(Number(merged.defaultInputSize), 1),
    }
  }
  return sanitized
}

function clampMin(value: number, min: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.round(value))
}

function clampFloat(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

function normalizePathForDisplay(value: string) {
  if (!value) return value
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice('\\\\?\\UNC\\'.length)}`
  if (value.startsWith('\\\\?\\')) return value.slice('\\\\?\\'.length)
  if (value.startsWith('\\??\\')) return value.slice('\\??\\'.length)
  return value
}

function normalizeComparablePath(value: string) {
  return normalizePathForDisplay(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

function errorToleranceValues(preset: ErrorTolerancePreset) {
  if (preset === 'strict') {
    return { errorToleranceSevereLimit: 5, errorToleranceMissingPictureLimit: 20 }
  }
  if (preset === 'lenient') {
    return { errorToleranceSevereLimit: 200, errorToleranceMissingPictureLimit: 1000 }
  }
  if (preset === 'failure_only') {
    return { errorToleranceSevereLimit: 0, errorToleranceMissingPictureLimit: 0 }
  }
  if (preset === 'balanced') {
    return { errorToleranceSevereLimit: 20, errorToleranceMissingPictureLimit: 100 }
  }
  return {
    ...defaultSettings.customErrorTolerance,
  }
}

function sanitizeErrorTolerancePreset(value: unknown): ErrorTolerancePreset {
  return value === 'strict'
    || value === 'balanced'
    || value === 'lenient'
    || value === 'failure_only'
    || value === 'custom'
    ? value
    : defaultSettings.errorTolerancePreset
}

function sanitizeErrorToleranceValues(
  value: Partial<SettingsSnapshot['customErrorTolerance']> | Partial<SettingsSnapshot>,
  fallback: SettingsSnapshot['customErrorTolerance'],
): SettingsSnapshot['customErrorTolerance'] {
  const severeLimit = Number(value.errorToleranceSevereLimit)
  const missingPictureLimit = Number(value.errorToleranceMissingPictureLimit)
  return {
    errorToleranceSevereLimit: Number.isFinite(severeLimit)
      ? clampMin(severeLimit, 0)
      : fallback.errorToleranceSevereLimit,
    errorToleranceMissingPictureLimit: Number.isFinite(missingPictureLimit)
      ? clampMin(missingPictureLimit, 0)
      : fallback.errorToleranceMissingPictureLimit,
    errorTolerancePreflightValidation: typeof value.errorTolerancePreflightValidation === 'boolean'
      ? value.errorTolerancePreflightValidation
      : fallback.errorTolerancePreflightValidation,
  }
}
