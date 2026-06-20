import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AnalysisMode,
  AnalysisPresetConfig,
  AnalysisPresetId,
  CloseBehavior,
  DeviceMode,
  EditableAnalysisPresetId,
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
  setCheckEnvOnStartup: (value: boolean) => void
  setOpenMaximized: (value: boolean) => void
  setCloseBehavior: (value: CloseBehavior) => void
  setAnalysisMode: (value: AnalysisMode) => void
  applyAnalysisPreset: (preset: AnalysisPresetId) => void
  saveCurrentAnalysisPreset: () => void
  hydrateAppDefaults: (defaults: Partial<Pick<SettingsSnapshot, 'projectRoot' | 'videoDir' | 'cacheDir' | 'reportDir'>>) => void
  resetBaseSettings: (defaults?: Partial<Pick<SettingsSnapshot, 'projectRoot' | 'videoDir' | 'cacheDir' | 'reportDir'>>) => void
  resetAnalysisSettings: () => void
  resetSettings: () => void
}

export type SettingsState = SettingsSnapshot & SettingsActions

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => {
      const updateAnalysis = (patch: Partial<AnalysisPresetConfig>) =>
        set((state) => applyAnalysisPatch(state, patch))

      return {
        ...defaultSettings,

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
        defaultCandidateLimit: clamp(defaultCandidateLimit, 0, 500),
      }),
      setDefaultMaxGapSec: (defaultMaxGapSec) => updateAnalysis({ defaultMaxGapSec }),
      setDefaultFrameStep: (defaultFrameStep) => updateAnalysis({ defaultFrameStep: clamp(defaultFrameStep, 1, 30) }),
      setDefaultMinSegmentDuration: (defaultMinSegmentDuration) => updateAnalysis({ defaultMinSegmentDuration: clamp(defaultMinSegmentDuration, 1, 120) }),
      setDefaultMinSegmentMatches: (defaultMinSegmentMatches) => updateAnalysis({ defaultMinSegmentMatches: clamp(defaultMinSegmentMatches, 1, 50) }),
      setDefaultOffsetTolerance: (defaultOffsetTolerance) => updateAnalysis({ defaultOffsetTolerance: clamp(defaultOffsetTolerance, 1, 60) }),
      setDefaultCropBlackBorders: (defaultCropBlackBorders) => updateAnalysis({ defaultCropBlackBorders }),
      setDefaultResizeMode: (defaultResizeMode) => updateAnalysis({ defaultResizeMode }),
      setDefaultInputSize: (defaultInputSize) => updateAnalysis({ defaultInputSize }),
      setDefaultPortraitRotation: (defaultPortraitRotation) => updateAnalysis({ defaultPortraitRotation }),
      setDefaultForce: (defaultForce) => updateAnalysis({ defaultForce }),
      setDefaultDevice: (defaultDevice) => updateAnalysis({ defaultDevice }),
      setCheckEnvOnStartup: (checkEnvOnStartup) => set({ checkEnvOnStartup }),
      setOpenMaximized: (openMaximized) => set({ openMaximized }),
      setCloseBehavior: (closeBehavior) => set({ closeBehavior }),
      setAnalysisMode: (analysisMode) => set({
        analysisMode,
        selectedAnalysisPreset: analysisMode === 'duplicate_file' ? 'duplicate_file' : 'normal',
      }),
      applyAnalysisPreset: (preset) =>
        set((state) => ({
          ...(preset === 'duplicate_file' ? analysisPresets.duplicate_file : state.customAnalysisPresets[preset]),
          selectedAnalysisPreset: preset,
        })),
      saveCurrentAnalysisPreset: () =>
        set((state) => {
          if (state.selectedAnalysisPreset === 'duplicate_file') return state
          const presetId = state.selectedAnalysisPreset
          return {
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
        }),
      resetAnalysisSettings: () =>
        set((state) => {
          const presetId = state.selectedAnalysisPreset === 'duplicate_file'
            ? 'normal'
            : state.selectedAnalysisPreset
          const builtInPreset = analysisPresets[presetId]
          return {
            ...builtInPreset,
            selectedAnalysisPreset: presetId,
            customAnalysisPresets: {
              ...state.customAnalysisPresets,
              [presetId]: { ...builtInPreset },
            },
          }
        }),
      resetSettings: () => set({
        ...defaultSettings,
        customAnalysisPresets: cloneEditableAnalysisPresets(),
      }),
      }
    },
    {
      name: 'video-similarity-settings',
      merge: (persisted, current) => ({
        ...current,
        ...sanitizePersistedSettings(persisted),
      }),
    },
  ),
)

function applyAnalysisPatch(
  state: SettingsState,
  patch: Partial<AnalysisPresetConfig>,
): Partial<SettingsSnapshot> {
  const presetId = state.selectedAnalysisPreset === 'duplicate_file'
    ? 'normal'
    : state.selectedAnalysisPreset
  const nextSettings = {
    ...state,
    ...patch,
    analysisMode: 'video_similarity' as const,
    selectedAnalysisPreset: presetId,
  }
  return {
    ...patch,
    analysisMode: 'video_similarity',
    selectedAnalysisPreset: presetId,
    customAnalysisPresets: {
      ...state.customAnalysisPresets,
      [presetId]: analysisPresetFromSettings(nextSettings),
    },
  }
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
  const legacyCloseToBackground = (snapshot as { closeToBackground?: unknown }).closeToBackground
  const closeBehavior: CloseBehavior = snapshot.closeBehavior === 'tray' || snapshot.closeBehavior === 'exit' || snapshot.closeBehavior === 'ask'
    ? snapshot.closeBehavior
    : legacyCloseToBackground === true
      ? 'tray'
      : defaultSettings.closeBehavior

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
    defaultInputSize: Number.isFinite(inputSize) ? clamp(inputSize, 128, 768) : defaultSettings.defaultInputSize,
    defaultFrameStep: Number.isFinite(frameStep) ? clamp(frameStep, 1, 30) : defaultSettings.defaultFrameStep,
    defaultCandidateLimit: Number.isFinite(candidateLimit) ? clamp(candidateLimit, 0, 500) : defaultSettings.defaultCandidateLimit,
    defaultMinSegmentDuration: Number.isFinite(minSegmentDuration) ? clamp(minSegmentDuration, 1, 120) : defaultSettings.defaultMinSegmentDuration,
    defaultMinSegmentMatches: Number.isFinite(minSegmentMatches) ? clamp(minSegmentMatches, 1, 50) : defaultSettings.defaultMinSegmentMatches,
    defaultOffsetTolerance: Number.isFinite(offsetTolerance) ? clamp(offsetTolerance, 1, 60) : defaultSettings.defaultOffsetTolerance,
    defaultPortraitRotation: portraitRotation,
    closeBehavior,
    analysisMode: snapshot.analysisMode === 'duplicate_file' ? 'duplicate_file' : defaultSettings.analysisMode,
    selectedAnalysisPreset: sanitizePresetId(snapshot.selectedAnalysisPreset),
    customAnalysisPresets: sanitizeCustomAnalysisPresets(snapshot.customAnalysisPresets),
  }
}

function analysisPresetFromSettings(settings: SettingsSnapshot): AnalysisPresetConfig {
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

function sanitizePresetId(value: unknown): AnalysisPresetId {
  return value === 'ultra_fast' || value === 'fast' || value === 'normal' || value === 'precise' || value === 'perfect' || value === 'duplicate_file'
    ? value
    : defaultSettings.selectedAnalysisPreset
}

function sanitizeCustomAnalysisPresets(value: unknown) {
  if (!value || typeof value !== 'object') return cloneEditableAnalysisPresets()
  const raw = value as Partial<Record<EditableAnalysisPresetId, Partial<AnalysisPresetConfig>>>
  const sanitized = cloneEditableAnalysisPresets()
  for (const presetId of ['ultra_fast', 'fast', 'normal', 'precise', 'perfect'] as const) {
    const candidate = raw[presetId]
    if (!candidate || typeof candidate !== 'object') continue
    const merged = { ...analysisPresets[presetId], ...candidate }
    sanitized[presetId] = {
      ...merged,
      analysisMode: 'video_similarity',
      defaultMatchThreshold: clampFloat(Number(merged.defaultMatchThreshold), 0.3, 0.99),
      defaultCandidateLimit: clamp(Number(merged.defaultCandidateLimit), 0, 500),
      defaultFrameStep: clamp(Number(merged.defaultFrameStep), 1, 30),
      defaultMinSegmentDuration: clamp(Number(merged.defaultMinSegmentDuration), 1, 120),
      defaultMinSegmentMatches: clamp(Number(merged.defaultMinSegmentMatches), 1, 50),
      defaultOffsetTolerance: clamp(Number(merged.defaultOffsetTolerance), 1, 60),
      defaultInputSize: clamp(Number(merged.defaultInputSize), 128, 768),
    }
  }
  return sanitized
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)))
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
