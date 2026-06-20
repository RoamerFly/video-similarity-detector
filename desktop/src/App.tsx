import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom'
import { AppLayout } from '@/components/AppLayout'
import { AnalyzePage } from '@/pages/AnalyzePage'
import { ComparePage } from '@/pages/ComparePage'
import { ResultsPage } from '@/pages/ResultsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { MergePage } from '@/pages/MergePage'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<AnalyzePage />} />
          <Route path="results" element={<ResultsPage />} />
          <Route path="compare" element={<ComparePage />} />
          <Route path="merge" element={<MergePage />} />
          <Route path="reports" element={<Navigate to="/results" replace />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
