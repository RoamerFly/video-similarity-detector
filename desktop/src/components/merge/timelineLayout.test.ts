import { describe, expect, it } from 'vitest'
import { timelineLayoutForRows } from './timelineLayout'

describe('timelineLayoutForRows', () => {
  it('sizes the panel to one real track instead of a fixed multi-track area', () => {
    const one = timelineLayoutForRows(1, false)
    const four = timelineLayoutForRows(4, false)

    expect(one.panelHeight).toBe(69)
    expect(four.panelHeight).toBeGreaterThan(one.panelHeight)
    expect(four.workspaceHeight).toBe(one.workspaceHeight + 3 * (34 + 3))
  })

  it('uses a compact row budget for short windows', () => {
    const compact = timelineLayoutForRows(1, true)
    const regular = timelineLayoutForRows(1, false)

    expect(compact.trackHeight).toBe(26)
    expect(compact.panelHeight).toBeLessThan(regular.panelHeight)
  })

  it('always leaves one video guide row for an empty project', () => {
    expect(timelineLayoutForRows(0, false).panelHeight).toBe(timelineLayoutForRows(1, false).panelHeight)
  })
})
