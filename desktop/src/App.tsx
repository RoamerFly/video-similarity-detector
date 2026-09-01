import { lazy, Suspense, useEffect } from 'react'
import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom'
import { AppLayout } from '@/components/AppLayout'
import { useI18n } from '@/i18n/useI18n'

const loadResultsPage = () => import('@/pages/ResultsPage').then((module) => ({ default: module.ResultsPage }))
const loadComparePage = () => import('@/pages/ComparePage').then((module) => ({ default: module.ComparePage }))
const loadMergePage = () => import('@/pages/MergePage').then((module) => ({ default: module.MergePage }))
const loadSettingsPage = () => import('@/pages/SettingsPage').then((module) => ({ default: module.SettingsPage }))

const AnalyzePage = lazy(() => import('@/pages/AnalyzePage').then((module) => ({ default: module.AnalyzePage })))
const ComparePage = lazy(loadComparePage)
const ResultsPage = lazy(loadResultsPage)
const SettingsPage = lazy(loadSettingsPage)
const MergePage = lazy(loadMergePage)

function LazyRoute({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <Suspense fallback={<div className="app-route-loading">{t('正在加载页面…')}</div>}>
      {children}
    </Suspense>
  )
}

function App() {
  // 预热非首页的路由 chunk。首页（分析任务）在启动时即已加载；其余页面首次点击
  // 会按需拉取并解析对应 chunk，造成「第一次切换卡顿」。这里在启动后短暂空闲时
  // 后台预热，之后切换即为瞬时。预热失败不影响正常按需加载。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadResultsPage().catch(() => undefined)
      loadComparePage().catch(() => undefined)
      loadMergePage().catch(() => undefined)
      loadSettingsPage().catch(() => undefined)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [])

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
