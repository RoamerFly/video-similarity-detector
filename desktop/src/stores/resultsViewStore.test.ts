import { describe, expect, it } from 'vitest'

import {
  migrateResultsViewState,
  RESULTS_VIEW_STORAGE_VERSION,
} from './resultsViewStore'

describe('results view persistence migration', () => {
  it('drops legacy filesystem report rows while preserving view preferences', () => {
    const migrated = migrateResultsViewState({
      activeTab: 'segments',
      query: 'clip',
      relationFilter: 'partial',
      reportReadFormat: 'json',
      sortState: { key: 'videoA', direction: 'asc' },
      selectedReportKey: 'D:/reports/report-A.json',
      reportOptions: [{ id: 'old-A' }],
      page: 4,
      pageSize: 50,
    }) as Record<string, unknown>

    expect(RESULTS_VIEW_STORAGE_VERSION).toBe(5)
    expect(migrated.reportOptions).toBeUndefined()
    expect(migrated.activeTab).toBe('segments')
    expect(migrated.query).toBe('clip')
    expect(migrated.relationFilter).toBe('partial')
    expect(migrated.reportReadFormat).toBe('json')
    expect(migrated.sortState).toEqual({ key: 'videoA', direction: 'asc' })
    expect(migrated.selectedReportKey).toBe('D:/reports/report-A.json')
    expect(migrated.page).toBe(4)
    expect(migrated.pageSize).toBe(20)
  })
})
