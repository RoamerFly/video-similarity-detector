import type { VideoRelation } from '@/utils/relation'

/**
 * Frame match information
 */
export interface FrameMatch {
  frameIndexA: number
  frameIndexB: number
  timestampA: number
  timestampB: number
  similarity: number
}

/**
 * Segment information
 */
export interface Segment {
  startTimeA: number
  endTimeA: number
  startTimeB: number
  endTimeB: number
  avgSimilarity: number
  matchCount: number
}

/**
 * Window similarity data
 */
export interface WindowSimilarity {
  windowStart: number
  windowEnd: number
  avgSimilarity: number
  maxSimilarity: number
  matchCount: number
}

/**
 * Video comparison result
 */
export interface ComparisonResult {
  id: string
  videoA: VideoInfo
  videoB: VideoInfo
  timestamp: string
  // Containment ratios
  aInB: number
  bInA: number
  symmetricSimilarity: number
  // Raw statistics
  rawSimilarityMax: number
  rawSimilarityMean: number
  rawSimilarityP95: number
  rawSimilarityP99: number
  // Relation
  relation: VideoRelation
  // Matches
  matchesAToB: FrameMatch[]
  matchesBToA: FrameMatch[]
  // Segments
  segments: Segment[]
  // Window similarities
  windows: WindowSimilarity[]
  // Settings used
  settings: ComparisonSettings
}

/**
 * Video information
 */
export interface VideoInfo {
  path: string
  name: string
  duration: number
  frameCount: number
  fps: number
  width: number
  height: number
  fileSize: number
}

/**
 * Comparison settings
 */
export interface ComparisonSettings {
  matchThreshold: number
  skipThreshold: number
  maxGapSec: number
  topK: number
  windowSize: number
  minSegmentDuration: number
  minSegmentMatches: number
  offsetTolerance: number
}

/**
 * Analysis task status
 */
export type TaskStatus = 'pending' | 'indexing' | 'comparing' | 'completed' | 'failed'

/**
 * Analysis task
 */
export interface AnalysisTask {
  id: string
  status: TaskStatus
  progress: number
  currentStep: string
  videoAPath: string
  videoBPath: string
  result?: ComparisonResult
  error?: string
  createdAt: string
  completedAt?: string
}

/**
 * Batch report data
 */
export interface BatchReport {
  id: string
  timestamp: string
  videoCount: number
  pairCount: string
  results: ComparisonResult[]
  warnings: string[]
}
