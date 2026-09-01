import { describe, expect, it } from 'vitest'
import { mergeExportCompactText } from './MergeExportStatus'

describe('merge export capsule state', () => {
  it('prioritizes a finalization error over a stale terminal progress value', () => {
    expect(mergeExportCompactText(100, '移动合并输出失败')).toBe('导出失败')
  })

  it('only displays completed after a successful terminal event', () => {
    expect(mergeExportCompactText(100, '')).toBe('已完成')
    expect(mergeExportCompactText(99, '')).toBe('99%')
  })

  it('shows a resumable paused state while the merge process remains active', () => {
    expect(mergeExportCompactText(42, '', true)).toBe('已暂停')
    expect(mergeExportCompactText(100, '', true)).toBe('已暂停')
  })
})
