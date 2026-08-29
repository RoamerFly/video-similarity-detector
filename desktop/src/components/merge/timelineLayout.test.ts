import { describe, expect, it } from 'vitest'
import { timelineLayoutForRows, timelinePanelHeightForViewport } from './timelineLayout'

describe('timelineLayoutForRows', () => {
  it('sizes the panel to one real track instead of a fixed multi-track area', () => {
    const one = timelineLayoutForRows(1, false)
    const four = timelineLayoutForRows(4, false)

    expect(one.panelHeight).toBe(89)
    expect(four.panelHeight).toBeGreaterThan(one.panelHeight)
    expect(four.workspaceHeight).toBe(one.workspaceHeight + 3 * (34 + 3))
  })

  it('uses a compact row budget for short windows', () => {
    const compact = timelineLayoutForRows(1, true)
    const regular = timelineLayoutForRows(1, false)

    expect(compact.trackHeight).toBe(26)
    expect(compact.panelHeight).toBeLessThan(regular.panelHeight)
    expect(compact.panelHeight).toBe(75)
  })

  it('always leaves one video guide row for an empty project', () => {
    expect(timelineLayoutForRows(0, false).panelHeight).toBe(timelineLayoutForRows(1, false).panelHeight)
  })

  it('accounts for the collapse row and keeps a scroll budget for many tracks', () => {
    const four = timelineLayoutForRows(4, true)
    const many = timelineLayoutForRows(12, true)
    expect(four.panelHeight).toBe(162)
    expect(many.panelHeight).toBeGreaterThan(800 * 0.42)
    expect(timelinePanelHeightForViewport(many, 800)).toBe(336)
    expect(timelinePanelHeightForViewport(four, 800)).toBe(four.panelHeight)
  })
})
