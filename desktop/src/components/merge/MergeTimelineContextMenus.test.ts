import { describe, expect, it } from 'vitest'

import { clampContextMenuPosition } from './contextMenuPosition'

describe('clampContextMenuPosition', () => {
  it('keeps menus reachable at every viewport edge', () => {
    expect(clampContextMenuPosition(-80, -10, 1280, 720, 240, 210)).toEqual({ left: 8, top: 8 })
    expect(clampContextMenuPosition(1240, 710, 1280, 720, 240, 210)).toEqual({ left: 1040, top: 510 })
  })
})
