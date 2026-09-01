import { describe, expect, it } from 'vitest'
import { analysisExportCompactText } from './AnalysisExportStatus'

describe('analysis export capsule state', () => {
  it('prioritizes errors over a stale terminal progress value', () => {
    expect(analysisExportCompactText(100, 'success', '分析进程异常退出')).toBe('分析失败')
    expect(analysisExportCompactText(100, 'error', '')).toBe('分析失败')
  })

  it('shows the actual terminal status instead of inferring it from progress', () => {
    expect(analysisExportCompactText(100, 'success', '')).toBe('已完成')
    expect(analysisExportCompactText(100, 'cancelled', '')).toBe('已取消')
    expect(analysisExportCompactText(99, 'running', '')).toBe('99%')
    expect(analysisExportCompactText(0, 'running', '')).toBe('分析中')
  })

  it('shows a pausing state before the backend process has stopped', () => {
    expect(analysisExportCompactText(47, 'running', '', true)).toBe('正在暂停')
  })
})
