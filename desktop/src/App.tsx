import { lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom'
import { AppLayout } from '@/components/AppLayout'

const AnalyzePage = lazy(() => import('@/pages/AnalyzePage').then((module) => ({ default: module.AnalyzePage })))
const ComparePage = lazy(() => import('@/pages/ComparePage').then((module) => ({ default: module.ComparePage })))
const ResultsPage = lazy(() => import('@/pages/ResultsPage').then((module) => ({ default: module.ResultsPage })))
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((module) => ({ default: module.SettingsPage })))
const MergePage = lazy(() => import('@/pages/MergePage').then((module) => ({ default: module.MergePage })))

function LazyRoute({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="app-route-loading">正在加载页面…</div>}>
      {children}
    </Suspense>
  )
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<LazyRoute><AnalyzePage /></LazyRoute>} />
          <Route path="results" element={<LazyRoute><ResultsPage /></LazyRoute>} />
          <Route path="compare" element={<LazyRoute><ComparePage /></LazyRoute>} />
          <Route path="merge" element={<LazyRoute><MergePage /></LazyRoute>} />
          <Route path="reports" element={<Navigate to="/results" replace />} />
          <Route path="settings" element={<LazyRoute><SettingsPage /></LazyRoute>} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
