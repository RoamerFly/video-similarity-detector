import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ComparisonResult, BatchReport } from '@/types/report'

interface ReportState {
  // Saved reports
  reports: BatchReport[]
  // Selected report for viewing
  selectedReport: BatchReport | null
  // Selected comparison result
  selectedComparison: ComparisonResult | null
  // Filter state
  filterRelation: string | null
  sortBy: 'date' | 'similarity' | 'name'
  sortOrder: 'asc' | 'desc'

  // Actions
  addReport: (report: BatchReport) => void
  deleteReport: (id: string) => void
  selectReport: (report: BatchReport | null) => void
  selectComparison: (comparison: ComparisonResult | null) => void
  setFilterRelation: (relation: string | null) => void
  setSortBy: (sortBy: 'date' | 'similarity' | 'name') => void
  setSortOrder: (order: 'asc' | 'desc') => void
  clearReports: () => void
}

export const useReportStore = create<ReportState>()(
  persist(
    (set) => ({
      reports: [],
      selectedReport: null,
      selectedComparison: null,
      filterRelation: null,
      sortBy: 'date',
      sortOrder: 'desc',

      addReport: (report) =>
        set((state) => ({
          reports: [report, ...state.reports],
        })),

      deleteReport: (id) =>
        set((state) => ({
          reports: state.reports.filter((r) => r.id !== id),
          selectedReport:
            state.selectedReport?.id === id ? null : state.selectedReport,
        })),

      selectReport: (report) =>
        set({ selectedReport: report, selectedComparison: null }),

      selectComparison: (comparison) =>
        set({ selectedComparison: comparison }),

      setFilterRelation: (relation) => set({ filterRelation: relation }),

      setSortBy: (sortBy) => set({ sortBy }),

      setSortOrder: (order) => set({ sortOrder: order }),

      clearReports: () =>
        set({ reports: [], selectedReport: null, selectedComparison: null }),
    }),
    {
      name: 'video-similarity-reports',
      partialize: (state) => ({ reports: state.reports }),
    }
  )
)
