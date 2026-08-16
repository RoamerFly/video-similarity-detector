import { describe, expect, it } from 'vitest'

import { layoutPatch, textPositionFromPoint } from './previewDraftCommit'

describe('preview draft commit helpers', () => {
  it('converts normalized layout data to one persistent patch', () => {
    expect(layoutPatch({ x: 0.25, y: 0, width: 0.5, height: 1 })).toEqual({ layoutCustom: true, layoutX: 0.25, layoutY: 0, layoutWidth: 0.5, layoutHeight: 1 })
  })

  it('clamps text pointer coordinates to the output canvas', () => {
    expect(textPositionFromPoint(250, 30, { left: 100, top: 50, width: 200, height: 100 })).toEqual({ x: 0.75, y: 0 })
  })
})
