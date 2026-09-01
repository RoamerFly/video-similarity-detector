import type { ReportSummary } from '@/services/backend'

export function mergeReports(reports: ReportSummary[]) {
  const byKey = new Map<string, ReportSummary>()
  for (const report of reports) {
    if (!report.jsonPath && !report.csvPath) continue
    const key = reportKey(report)
    if (!key) continue
    const current = byKey.get(key)
    if (
      !current
      || (isSyntheticReport(current) && !isSyntheticReport(report))
      || (!isSyntheticReport(report) && timeValue(report.modifiedAt) > timeValue(current.modifiedAt))
    ) {
      byKey.set(key, report)
    }
  }
  return Array.from(byKey.values()).sort((left, right) => compareNullableNumber(timeValue(right.modifiedAt), timeValue(left.modifiedAt)))
}

export function reportKey(report: ReportSummary) {
  return report.path || report.jsonPath || report.csvPath || report.htmlPath || report.id
}

function isSyntheticReport(report: ReportSummary) {
  return report.id === 'latest-report' && report.sizeBytes === 0
}

function normalizedReportPath(path?: string) {
  const normalized = path?.trim().replaceAll('\\', '/').replace(/\/+$/, '') || ''
  // Windows drive and UNC paths are case-insensitive. Preserve case for
  // POSIX paths so similarly shaped paths such as /reports/A and /reports/a
  // remain distinct on macOS/Linux.
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

function reportContainsPath(report: ReportSummary, path?: string) {
  const target = normalizedReportPath(path)
  if (!target) return false
  return [report.path, report.jsonPath, report.csvPath, report.htmlPath]
    .some((candidate) => normalizedReportPath(candidate) === target)
}

export function findReportForPaths(
  reports: ReportSummary[],
  paths: { reportJson?: string; reportCsv?: string },
) {
  return reports.find((report) => (
    reportContainsPath(report, paths.reportJson) || reportContainsPath(report, paths.reportCsv)
  )) ?? null
}

export function syntheticReportFromPaths(paths: { reportJson?: string; reportCsv?: string }, id: string): ReportSummary {
  const path = paths.reportJson || paths.reportCsv || ''
  const now = new Date().toISOString()
  return {
    id,
    path,
    jsonPath: paths.reportJson,
    csvPath: paths.reportCsv,
    htmlPath: undefined,
    name: reportNameFromPath(path),
    createdAt: now,
    modifiedAt: now,
    sizeBytes: 0,
    videoCount: 0,
    pairCount: 0,
    warningCount: 0,
    status: '最近分析',
    formats: ['JSON', 'CSV'].filter((_, index) => [paths.reportJson, paths.reportCsv][index]),
  }
}

function reportNameFromPath(path?: string) {
  if (!path) return '最近分析报告'
  const name = fileNameFromPath(path)
  return name.replace(/\.(json|csv|html)$/i, '') || name
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function compareNullableNumber(left: number | null | undefined, right: number | null | undefined) {
  const leftOk = Number.isFinite(left ?? Number.NaN)
  const rightOk = Number.isFinite(right ?? Number.NaN)
  if (!leftOk && !rightOk) return 0
  if (!leftOk) return -1
  if (!rightOk) return 1
  return (left as number) - (right as number)
}

function timeValue(value: string) {
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value)) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000
  }
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}
