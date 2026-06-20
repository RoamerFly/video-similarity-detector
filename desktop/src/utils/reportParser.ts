import { fileName, pathStatus, readTextFile, siblingPath } from '@/services/backend'
import { determineRelation } from '@/utils/relation'

export interface ReportSegment {
  aStart: number | null
  aEnd: number | null
  bStart: number | null
  bEnd: number | null
  coverage: number | null
  avgSimilarity: number | null
  confidence: number | null
  matchCount: number | null
}

export interface ReportWindow {
  direction: 'A_to_B' | 'B_to_A' | 'combined' | string
  sourceStart: number | null
  sourceEnd: number | null
  matchedFrameCount: number | null
  matchedFrameRatio: number | null
  avgSimilarity: number | null
  bestTargetStart: number | null
  bestTargetEnd: number | null
}

export interface ReportFrameMatch {
  direction: 'A_to_B' | 'B_to_A'
  sourceVideo: string
  targetVideo: string
  sourceFrameIndex: number | null
  targetFrameIndex: number | null
  sourceTimestamp: number | null
  targetTimestamp: number | null
  similarity: number | null
  sourceThumbnailPath?: string
  targetThumbnailPath?: string
}

export interface ReportPair {
  id: string
  completedAt: string
  videoA: string
  videoB: string
  videoAPath: string
  videoBPath: string
  aInB: number | null
  bInA: number | null
  symmetricSimilarity: number | null
  avgSimilarityAToB: number | null
  avgSimilarityBToA: number | null
  relation: string
  matchedSegmentCount: number
  matchedSegments: ReportSegment[]
  windowSimilarity: ReportWindow[]
  frameMatches: ReportFrameMatch[]
  matchesAToBTotal: number
  matchesBToATotal: number
  totalFramesA: number
  totalFramesB: number
  durationA: number
  durationB: number
  raw: Record<string, unknown>
}

export interface ReportSummaryStats {
  videos: number
  pairs: number
  highPairs: number
  partialPairs: number
  segments: number
}

export interface BatchReport {
  timestamp: string
  warnings: string[]
  pairs: ReportPair[]
  summary: ReportSummaryStats
  sourcePath: string
  sourceFormat: 'json' | 'csv'
}

export interface ReportSourcePaths {
  reportJson?: string
  reportCsv?: string
}

export class ReportParseError extends Error {
  rawPath?: string

  constructor(message: string, rawPath?: string) {
    super(message)
    this.name = 'ReportParseError'
    this.rawPath = rawPath
  }
}

export async function loadBatchReport(paths: ReportSourcePaths, threshold = 0.65): Promise<BatchReport> {
  const jsonPath = paths.reportJson?.trim()
  const csvPath = paths.reportCsv?.trim() || (jsonPath ? siblingPath(jsonPath, 'csv') : '')
  const errors: string[] = []
  let sawExistingFile = false

  if (jsonPath) {
    try {
      if (!await isReadableFile(jsonPath)) {
        errors.push(`JSON: 报告文件尚未生成 ${jsonPath}`)
      } else {
        sawExistingFile = true
        const content = await readTextFile(jsonPath)
        return parseJsonReport(content, jsonPath, threshold)
      }
    } catch (error) {
      errors.push(`JSON: ${stringifyError(error)}`)
    }
  }

  if (csvPath) {
    try {
      if (!await isReadableFile(csvPath)) {
        errors.push(`CSV: 报告文件尚未生成 ${csvPath}`)
      } else {
        sawExistingFile = true
        const content = await readTextFile(csvPath)
        return parseCsvReport(content, csvPath, threshold)
      }
    } catch (error) {
      errors.push(`CSV: ${stringifyError(error)}`)
    }
  }

  if (!sawExistingFile && (jsonPath || csvPath)) {
    throw new ReportParseError('尚未找到可读取的报告文件，完成分析后会自动显示结果。', jsonPath || csvPath)
  }

  throw new ReportParseError(
    errors.length > 0 ? `报告解析失败：${errors.join('；')}` : '尚未运行分析，请先选择视频目录并开始分析。',
    jsonPath || csvPath,
  )
}

async function isReadableFile(path: string) {
  const status = await pathStatus(path)
  return status.exists && status.isFile
}

export function parseJsonReport(content: string, sourcePath: string, threshold = 0.65): BatchReport {
  const data = JSON.parse(content) as unknown
  const record = asRecord(data)
  const rawPairs = Array.isArray(record.video_pairs)
    ? record.video_pairs
    : record.video_a && record.video_b
      ? [record]
      : []
  const reportTimestamp = textValue(record.timestamp)
  const pairs = dedupePairs(rawPairs.map((item, index) => normalizePair(asRecord(item), index, reportTimestamp, threshold)))
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.map((item) => String(item))
    : []

  return {
    timestamp: reportTimestamp,
    warnings,
    pairs,
    summary: summarizePairs(pairs, threshold),
    sourcePath,
    sourceFormat: 'json',
  }
}

export function parseCsvReport(content: string, sourcePath: string, threshold = 0.65): BatchReport {
  const rows = parseCsv(content)
  const pairs = dedupePairs(rows.map((row, index) => normalizePair(row, index, '', threshold)))
  return {
    timestamp: '',
    warnings: [],
    pairs,
    summary: summarizePairs(pairs, threshold),
    sourcePath,
    sourceFormat: 'csv',
  }
}

function dedupePairs(pairs: ReportPair[]) {
  const byPair = new Map<string, ReportPair>()

  for (const pair of pairs) {
    const key = unorderedPairKey(pair)
    const current = byPair.get(key)
    if (!current || pairCompleteness(pair) > pairCompleteness(current)) {
      byPair.set(key, pair)
    }
  }

  return Array.from(byPair.values())
}

function unorderedPairKey(pair: ReportPair) {
  const left = pairIdentity(pair.videoAPath || pair.videoA)
  const right = pairIdentity(pair.videoBPath || pair.videoB)
  return [left, right].sort().join('||')
}

function pairIdentity(value: string) {
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return normalized || '-'
}

function pairCompleteness(pair: ReportPair) {
  const score = [
    pair.frameMatches.length * 3,
    pair.matchedSegments.length * 8,
    pair.windowSimilarity.length * 2,
    pair.matchesAToBTotal,
    pair.matchesBToATotal,
    Number.isFinite(pair.symmetricSimilarity ?? Number.NaN) ? 1 : 0,
    Number.isFinite(pair.aInB ?? Number.NaN) ? 1 : 0,
    Number.isFinite(pair.bInA ?? Number.NaN) ? 1 : 0,
  ]
  return score.reduce((sum, value) => sum + value, 0)
}

export function summarizePairs(pairs: ReportPair[], threshold = 0.65): ReportSummaryStats {
  const videos = new Set<string>()
  let highPairs = 0
  let partialPairs = 0
  let segments = 0

  for (const pair of pairs) {
    if (pair.videoAPath || pair.videoA) videos.add(pair.videoAPath || pair.videoA)
    if (pair.videoBPath || pair.videoB) videos.add(pair.videoBPath || pair.videoB)
    const score = pair.symmetricSimilarity ?? Math.max(pair.aInB ?? 0, pair.bInA ?? 0)
    if (score >= threshold) highPairs += 1
    if (isPartialRelation(pair.relation)) partialPairs += 1
    segments += pair.matchedSegmentCount
  }

  return {
    videos: videos.size,
    pairs: pairs.length,
    highPairs,
    partialPairs,
    segments,
  }
}

export function formatPercent(value: number | null | undefined) {
  if (!Number.isFinite(value ?? Number.NaN)) return '-'
  return `${(((value as number) <= 1 ? (value as number) * 100 : (value as number))).toFixed(1)}%`
}

export function formatScore(value: number | null | undefined) {
  if (!Number.isFinite(value ?? Number.NaN)) return '-'
  const numeric = value as number
  return (numeric > 1 ? numeric / 100 : numeric).toFixed(2)
}

export function metricPercent(value: number | null | undefined) {
  if (!Number.isFinite(value ?? Number.NaN)) return 0
  const numeric = value as number
  return Math.max(0, Math.min(100, numeric <= 1 ? numeric * 100 : numeric))
}

export function formatHHMMSS(value: number | null | undefined) {
  if (!Number.isFinite(value ?? Number.NaN)) return '-'
  const totalSeconds = Math.max(0, Math.floor(value as number))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
}

function normalizePair(
  record: Record<string, unknown>,
  index: number,
  reportTimestamp: string,
  threshold: number,
): ReportPair {
  const videoAPath = textValue(record.video_a_path) || textValue(record.video_a)
  const videoBPath = textValue(record.video_b_path) || textValue(record.video_b)
  const rawSegments = arrayValue(record.matched_segments) || arrayValue(record.segments) || []
  const matchedSegments = rawSegments.map((item) => normalizeSegment(asRecord(item)))
  const matchedSegmentCount = numberValue(record.matched_segment_count)
  const windowSimilarity = normalizeWindows(record)
  const pairThreshold = Math.max(0.3, normalizedRatio(record.match_threshold) ?? threshold)
  const frameMatches = normalizeFrameMatches(record, pairThreshold)
  const aInB = normalizedRatio(record.a_in_b)
  const bInA = normalizedRatio(record.b_in_a)
  const totalFramesA = numberValue(record.total_frames_a) ?? 0
  const totalFramesB = numberValue(record.total_frames_b) ?? 0
  const durationA = numberValue(record.duration_a) ?? 0
  const durationB = numberValue(record.duration_b) ?? 0
  const reportedRelation = textValue(record.relation) || 'unknown'
  const relation = normalizeReportedRelation(
    reportedRelation,
    aInB,
    bInA,
    threshold,
    totalFramesA,
    totalFramesB,
    durationA,
    durationB,
  )

  return {
    id: `${videoAPath || textValue(record.video_a) || 'video-a'}__${videoBPath || textValue(record.video_b) || 'video-b'}__${index}`,
    completedAt: firstText(record, ['completed_at', 'finished_at', 'timestamp', 'created_at', 'modified_at']) || reportTimestamp,
    videoA: textValue(record.video_a) || fileName(videoAPath) || '-',
    videoB: textValue(record.video_b) || fileName(videoBPath) || '-',
    videoAPath,
    videoBPath,
    aInB,
    bInA,
    symmetricSimilarity: normalizedRatio(record.symmetric_similarity),
    avgSimilarityAToB: normalizedRatio(record.avg_similarity_a_to_b),
    avgSimilarityBToA: normalizedRatio(record.avg_similarity_b_to_a),
    relation,
    matchedSegmentCount: matchedSegmentCount ?? matchedSegments.length,
    matchedSegments,
    windowSimilarity,
    frameMatches,
    matchesAToBTotal: numberValue(record.matches_a_to_b_total) ?? frameMatches.filter((match) => match.direction === 'A_to_B').length,
    matchesBToATotal: numberValue(record.matches_b_to_a_total) ?? frameMatches.filter((match) => match.direction === 'B_to_A').length,
    totalFramesA,
    totalFramesB,
    durationA,
    durationB,
    raw: compactRawPair(record),
  }
}

function normalizeSegment(record: Record<string, unknown>): ReportSegment {
  return {
    aStart: firstNumber(record, ['a_start', 'start_a', 'start_time_a', 'source_start']),
    aEnd: firstNumber(record, ['a_end', 'end_a', 'end_time_a', 'source_end']),
    bStart: firstNumber(record, ['b_start', 'start_b', 'start_time_b', 'target_start']),
    bEnd: firstNumber(record, ['b_end', 'end_b', 'end_time_b', 'target_end']),
    coverage: firstNumber(record, ['coverage']),
    avgSimilarity: firstNumber(record, ['avg_similarity', 'similarity']),
    confidence: firstNumber(record, ['confidence']),
    matchCount: firstNumber(record, ['match_count', 'matches']),
  }
}

function normalizeWindows(record: Record<string, unknown>): ReportWindow[] {
  const windows: ReportWindow[] = []
  const legacyWindows = arrayValue(record.window_similarity) || arrayValue(record.windows) || []

  for (const item of legacyWindows) {
    const window = asRecord(item)
    windows.push(normalizeWindow(window, textValue(window.direction) || 'combined'))
  }

  for (const item of arrayValue(record.windows_a_to_b) || []) {
    windows.push(normalizeWindow(asRecord(item), 'A_to_B'))
  }

  for (const item of arrayValue(record.windows_b_to_a) || []) {
    windows.push(normalizeWindow(asRecord(item), 'B_to_A'))
  }

  return dedupeWindows(windows)
}

function normalizeWindow(record: Record<string, unknown>, direction: string): ReportWindow {
  return {
    direction,
    sourceStart: firstNumber(record, ['source_start', 'a_start', 'start']),
    sourceEnd: firstNumber(record, ['source_end', 'a_end', 'end']),
    matchedFrameCount: firstNumber(record, ['matched_frame_count', 'match_count']),
    matchedFrameRatio: firstNumber(record, ['matched_frame_ratio', 'coverage']),
    avgSimilarity: firstNumber(record, ['avg_similarity', 'similarity']),
    bestTargetStart: firstNumber(record, ['best_target_start', 'target_start', 'b_start']),
    bestTargetEnd: firstNumber(record, ['best_target_end', 'target_end', 'b_end']),
  }
}

function dedupeWindows(windows: ReportWindow[]) {
  const seen = new Set<string>()
  return windows.filter((window) => {
    const key = [
      window.direction,
      window.sourceStart,
      window.sourceEnd,
      window.bestTargetStart,
      window.bestTargetEnd,
    ].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeFrameMatches(record: Record<string, unknown>, threshold: number): ReportFrameMatch[] {
  const aToB = (arrayValue(record.matches_a_to_b) || [])
    .map((item) => normalizeFrameMatch(asRecord(item), 'A_to_B'))
  const bToA = (arrayValue(record.matches_b_to_a) || [])
    .map((item) => normalizeFrameMatch(asRecord(item), 'B_to_A'))
  return [...aToB, ...bToA]
    .filter((match) => match.similarity !== null && match.similarity >= threshold)
    .sort((left, right) => (right.similarity ?? -1) - (left.similarity ?? -1))
}

function normalizeFrameMatch(record: Record<string, unknown>, direction: 'A_to_B' | 'B_to_A'): ReportFrameMatch {
  return {
    direction,
    sourceVideo: textValue(record.source_video),
    targetVideo: textValue(record.target_video),
    sourceFrameIndex: firstNumber(record, ['source_frame_index', 'frame_index_a']),
    targetFrameIndex: firstNumber(record, ['target_frame_index', 'frame_index_b']),
    sourceTimestamp: firstNumber(record, ['source_timestamp', 'timestamp_a']),
    targetTimestamp: firstNumber(record, ['target_timestamp', 'timestamp_b']),
    similarity: normalizedRatio(firstNumber(record, ['similarity', 'score'])),
    sourceThumbnailPath: textValue(record.source_thumbnail_path),
    targetThumbnailPath: textValue(record.target_thumbnail_path),
  }
}

function parseCsv(content: string) {
  const rows = content.trim().split(/\r?\n/)
  if (rows.length <= 1) return []
  const headers = splitCsvLine(rows[0]).map((header) => header.trim())
  return rows.slice(1).filter(Boolean).map((row) => {
    const values = splitCsvLine(row)
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  })
}

function splitCsvLine(line: string) {
  const values: string[] = []
  let current = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]
    if (char === '"' && quoted && next === '"') {
      current += '"'
      index += 1
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (char === ',' && !quoted) {
      values.push(current)
      current = ''
      continue
    }
    current += char
  }

  values.push(current)
  return values
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  return {}
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : null
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function numberValue(value: unknown) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function normalizedRatio(value: unknown) {
  const numeric = numberValue(value)
  if (numeric === null) return null
  const ratio = numeric > 1 && numeric <= 100 ? numeric / 100 : numeric
  return Math.max(0, Math.min(1, ratio))
}

function normalizeReportedRelation(
  reported: string,
  aInB: number | null,
  bInA: number | null,
  threshold: number,
  totalFramesA: number,
  totalFramesB: number,
  durationA: number,
  durationB: number,
) {
  if (reported === 'identical_file' || reported === 'identical') return reported
  if (aInB === null || bInA === null) return reported

  const derived = determineRelation(
    aInB,
    bInA,
    Math.max(0.8, threshold),
    totalFramesA,
    totalFramesB,
    durationA,
    durationB,
  )
  const reportedIsDirectional = reported === 'A_is_likely_clip_of_B'
    || reported === 'B_is_likely_clip_of_A'
    || reported === 'a_contains_b'
    || reported === 'b_contains_a'
  const derivedIsDirectional = derived === 'A_is_likely_clip_of_B'
    || derived === 'B_is_likely_clip_of_A'

  // Old reports can contain a reversed directional label. Prefer the metrics
  // and media lengths when they provide a clear containment direction.
  if (derivedIsDirectional || reportedIsDirectional) return derived
  return reported === 'unknown' ? derived : reported
}

function compactRawPair(record: Record<string, unknown>) {
  const keys = [
    'analysis_mode',
    'duplicate_group_paths',
    'file_size_bytes',
    'fingerprint',
    'raw_similarity_max',
    'raw_similarity_mean',
    'raw_similarity_p95',
    'raw_similarity_p99',
    'preprocess_config',
    'match_threshold',
  ]
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]))
}

function firstNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const numeric = numberValue(record[key])
    if (numeric !== null) return numeric
  }
  return null
}

function firstText(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = textValue(record[key]).trim()
    if (value) return value
  }
  return ''
}

function isPartialRelation(relation: string) {
  const normalized = relation.toLowerCase()
  return normalized.includes('partial')
    || normalized.includes('clip')
    || normalized.includes('contain')
    || relation.includes('重叠')
    || relation.includes('包含')
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
