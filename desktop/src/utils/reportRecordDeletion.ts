import { summarizePairs, type BatchReport, type ReportPair } from '@/utils/reportParser'
import type { ReportPairIdentity } from '@/services/backend'

/**
 * Resolve a path written by a report to the same path the UI will use for
 * file operations. Reports from older runs sometimes contain a filename or a
 * relative path, while newer reports contain an absolute path.
 */
export function resolveReportVideoPath(path: string | undefined, fallbackName: string | undefined, videoDir: string) {
  const candidate = String(path ?? '').trim()
  const fallback = String(fallbackName ?? '').trim()
  if (isAbsoluteVideoPath(candidate)) return candidate

  const relative = candidate || fallback
  const base = videoDir.trim().replace(/[\\/]+$/, '')
  if (!relative) return base
  if (!base) return relative

  const separator = base.includes('\\') ? '\\' : '/'
  return `${base}${separator}${relative.replace(/^[\\/]+/, '')}`
}

/** Normalize Windows paths for identity comparisons without losing directories. */
export function normalizeVideoIdentity(path: string | undefined) {
  let value = String(path ?? '').trim()
  if (!value) return ''

  // Windows extended path prefixes identify the same filesystem path.
  value = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/i, '')
  value = value.replaceAll('\\', '/')

  const isDrivePath = /^[A-Za-z]:\//.test(value)
  const isUncPath = value.startsWith('//')
  const isPosixPath = value.startsWith('/')
  const prefix = isDrivePath ? value.slice(0, 3) : isUncPath ? '//' : isPosixPath ? '/' : ''
  const body = prefix ? value.slice(prefix.length) : value
  const parts: string[] = []
  for (const part of body.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!prefix) parts.push(part)
      continue
    }
    parts.push(part)
  }

  let normalized = `${prefix}${parts.join('/')}`.replace(/\/+$/, '')
  if (isDrivePath && normalized.length === 2) normalized += '/'
  if (isUncPath && normalized === '//') normalized = ''

  // Drive-letter and UNC paths are case-insensitive on Windows. Keep POSIX
  // paths case-sensitive so this helper remains safe if used on macOS/Linux.
  return isDrivePath || isUncPath ? normalized.toLowerCase() : normalized
}

export function reportPairVideoPaths(pair: ReportPair, videoDir: string) {
  const paths = [
    resolveReportVideoPath(pair.videoAPath, pair.videoA, videoDir),
    resolveReportVideoPath(pair.videoBPath, pair.videoB, videoDir),
  ]
  const duplicateGroupPaths = Array.isArray(pair.raw.duplicate_group_paths)
    ? pair.raw.duplicate_group_paths
      .map((path) => resolveReportVideoPath(String(path ?? ''), '', videoDir))
      .filter(Boolean)
    : []

  const seen = new Set<string>()
  return [...paths, ...duplicateGroupPaths].filter((path) => {
    const identity = normalizeVideoIdentity(path)
    if (!identity || seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

export function pairContainsDeletedPath(pair: ReportPair, deletedPaths: Iterable<string>, videoDir: string) {
  const deleted = new Set(Array.from(deletedPaths, normalizeVideoIdentity).filter(Boolean))
  if (deleted.size === 0) return false
  return reportPairVideoPaths(pair, videoDir)
    .some((path) => deleted.has(normalizeVideoIdentity(path)))
}

export function findPairsForDeletedPaths(pairs: ReportPair[], deletedPaths: Iterable<string>, videoDir: string) {
  return pairs.filter((pair) => pairContainsDeletedPath(pair, deletedPaths, videoDir))
}

/**
 * Apply a successful backend report update without mutating the original
 * store value. A short backend result is treated as a failure, so callers do
 * not present stale report state as if it had been persisted.
 */
export function applyReportDeletionResult(
  report: BatchReport,
  affectedPairs: ReportPair[],
  removedCount: number,
  threshold: number,
) {
  if (removedCount !== affectedPairs.length) {
    return {
      success: false,
      report: null,
      error: `报告仅更新了 ${removedCount}/${affectedPairs.length} 条相关记录。`,
    }
  }

  const affectedIds = new Set(affectedPairs.map((pair) => pair.id))
  const remainingPairs = report.pairs.filter((pair) => !affectedIds.has(pair.id))
  return {
    success: true,
    report: { ...report, pairs: remainingPairs, summary: summarizePairs(remainingPairs, threshold) },
    error: '',
  }
}

/** Keep the report's original identities so the backend can match legacy rows. */
export function reportPairIdentity(pair: ReportPair): ReportPairIdentity {
  return {
    videoA: pair.videoA,
    videoB: pair.videoB,
    videoAPath: pair.videoAPath,
    videoBPath: pair.videoBPath,
  }
}

export function isAbsoluteVideoPath(path: string) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path)
}
