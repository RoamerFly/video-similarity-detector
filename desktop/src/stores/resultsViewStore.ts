import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ReportSummary } from '@/services/backend'

export type ResultsTab = 'results' | 'segments' | 'windows'
export type RelationFilter = 'all' | 'near' | 'partial' | 'clip' | 'different' | 'unknown'
export type ReportReadFormat = 'auto' | 'json' | 'csv'
export type ResultsSortKey =
  | 'completedAt'
  | 'videoA'
  | 'videoB'
  | 'aInB'
  | 'bInA'
  | 'symmetricSimilarity'
  | 'relation'
  | 'matchedSegmentCount'
  | 'frameMatches'

export interface ResultsSortState {
  key: ResultsSortKey
  direction: 'asc' | 'desc'
}

interface ResultsViewState {
  activeTab: ResultsTab
  query: string
  relationFilter: RelationFilter
  reportReadFormat: ReportReadFormat
  sortState: ResultsSortState
  selectedReportKey: string
  reportOptions: ReportSummary[]
  page: number
  pageSize: number
  setActiveTab: (activeTab: ResultsTab) => void
  setQuery: (query: string) => void
  setRelationFilter: (relationFilter: RelationFilter) => void
  setReportReadFormat: (reportReadFormat: ReportReadFormat) => void
  setSortState: (sortState: ResultsSortState) => void
  setSelectedReportKey: (selectedReportKey: string) => void
  setReportOptions: (reportOptions: ReportSummary[]) => void
  setPage: (page: number) => void
  setPageSize: (pageSize: number) => void
  resetPage: () => void
}

export const RESULTS_VIEW_STORAGE_VERSION = 5

/**
 * Migrate view preferences without carrying filesystem-derived report rows
 * across launches. Report rows are refreshed from the configured directories
 * when ResultsPage is entered; filters, sorting, and pagination remain user
 * preferences.
 */
export function migrateResultsViewState(persistedState: unknown) {
  if (!persistedState || typeof persistedState !== 'object') return persistedState
  const state = persistedState as Partial<ResultsViewState>
  const { reportOptions: _legacyReportOptions, ...next } = state
  // v4: 结果总览默认每页显示更多行，配合紧凑分页节省空间。
  next.pageSize = 20
  if (!next.sortState || next.sortState.key === 'completedAt') {
    next.sortState = { key: 'symmetricSimilarity', direction: 'desc' }
  }
  return next
}

export const useResultsViewStore = create<ResultsViewState>()(
  persist(
    (set) => ({
      activeTab: 'results',
      query: '',
      relationFilter: 'all',
      reportReadFormat: 'auto',
      sortState: { key: 'symmetricSimilarity', direction: 'desc' },
      selectedReportKey: '',
      reportOptions: [],
      page: 1,
      pageSize: 20,
      setActiveTab: (activeTab) => set({ activeTab }),
      setQuery: (query) => set({ query }),
      setRelationFilter: (relationFilter) => set({ relationFilter }),
      setReportReadFormat: (reportReadFormat) => set({ reportReadFormat }),
      setSortState: (sortState) => set({ sortState }),
      setSelectedReportKey: (selectedReportKey) => set({ selectedReportKey }),
      setReportOptions: (reportOptions) => set({ reportOptions }),
      setPage: (page) => set({ page: Math.max(1, Math.floor(page) || 1) }),
      setPageSize: (pageSize) => set({ pageSize: Math.max(1, Math.floor(pageSize) || 10), page: 1 }),
      resetPage: () => set({ page: 1 }),
    }),
    {
      name: 'video-similarity-results-view:v2',
      version: RESULTS_VIEW_STORAGE_VERSION,
      migrate: migrateResultsViewState,
      partialize: (state) => ({
        activeTab: state.activeTab,
        query: state.query,
        relationFilter: state.relationFilter,
        reportReadFormat: state.reportReadFormat,
        sortState: state.sortState,
        selectedReportKey: state.selectedReportKey,
        page: state.page,
        pageSize: state.pageSize,
      }),
    },
  ),
)
