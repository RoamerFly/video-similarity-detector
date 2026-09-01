import { describe, expect, it } from 'vitest'

import {
  findReportForPaths,
  mergeReports,
  reportKey,
  syntheticReportFromPaths,
} from './ResultsPage'
import type { ReportSummary } from '@/services/backend'

function report(path: string, modifiedAt: string): ReportSummary {
  return {
    id: path,
    path,
    jsonPath: path,
    csvPath: path.replace(/\.json$/i, '.csv'),
    name: path.split(/[\\/]/).pop()?.replace(/\.json$/i, '') ?? path,
    createdAt: modifiedAt,
    modifiedAt,
    sizeBytes: 123,
    videoCount: 2,
    pairCount: 1,
    warningCount: 0,
    status: '可查看',
    formats: ['JSON', 'CSV'],
  }
}

describe('results report list identity', () => {
  it('keeps a freshly completed B report beside persisted A and selects B by full path', () => {
    const persistedA = report('D:/reports/report-A.json', '2026-08-30T10:00:00.000Z')
    const refreshedA = report('D:/reports/report-A.json', '2026-08-30T10:00:00.000Z')
    const refreshedB = report('D:/reports/report-B.json', '2026-09-01T10:00:00.000Z')
    const currentPaths = {
      reportJson: refreshedB.jsonPath,
      reportCsv: refreshedB.csvPath,
    }
    const syntheticCurrent = syntheticReportFromPaths(currentPaths, 'latest-report')

    const merged = mergeReports([persistedA, syntheticCurrent, refreshedA, refreshedB])
    const selected = findReportForPaths(merged, currentPaths)

    expect(merged).toHaveLength(2)
    expect(merged.map(reportKey)).toEqual(expect.arrayContaining([
      persistedA.path,
      refreshedB.path,
    ]))
    expect(selected?.path).toBe(refreshedB.path)
    expect(selected?.pairCount).toBe(refreshedB.pairCount)
  })

  it('keeps a current report path when the refreshed directory response does not include it', () => {
    const currentPaths = { reportJson: 'D:/reports/report-B.json' }
    const merged = mergeReports([
      syntheticReportFromPaths(currentPaths, 'latest-report'),
      report('D:/reports/report-A.json', '2026-09-01T09:00:00.000Z'),
    ])

    expect(findReportForPaths(merged, currentPaths)?.path).toBe(currentPaths.reportJson)
  })

  it('keeps case-sensitive POSIX report paths distinct', () => {
    const upper = report('/reports/A.json', '2026-09-01T09:00:00.000Z')
    const lower = report('/reports/a.json', '2026-09-01T10:00:00.000Z')

    expect(mergeReports([upper, lower])).toHaveLength(2)
    expect(findReportForPaths([upper], { reportJson: '/reports/a.json' })).toBeNull()
  })
})
