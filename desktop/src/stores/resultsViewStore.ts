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

export const useResultsViewStore = create<ResultsViewState>()(
  persist(
    (set) => ({
      activeTab: 'results',
      query: '',
      relationFilter: 'all',
      reportReadFormat: 'auto',
      sortState: { key: 'completedAt', direction: 'desc' },
      selectedReportKey: '',
      reportOptions: [],
      page: 1,
      pageSize: 10,
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
      partialize: (state) => ({
        activeTab: state.activeTab,
        query: state.query,
        relationFilter: state.relationFilter,
        reportReadFormat: state.reportReadFormat,
        sortState: state.sortState,
        selectedReportKey: state.selectedReportKey,
        reportOptions: state.reportOptions,
        page: state.page,
        pageSize: state.pageSize,
      }),
    },
  ),
)
