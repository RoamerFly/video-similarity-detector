import { describe, expect, it } from 'vitest'
import { shouldShowOverlapToolbar } from './mergeToolbarVisibility'

describe('shouldShowOverlapToolbar', () => {
  it('hides layout controls for one active video', () => {
    expect(shouldShowOverlapToolbar(1)).toBe(false)
  })

  it('shows layout controls while videos overlap', () => {
    expect(shouldShowOverlapToolbar(2)).toBe(true)
  })

  it('keeps controls available for a selected group or active edit', () => {
    expect(shouldShowOverlapToolbar(1, true)).toBe(true)
    expect(shouldShowOverlapToolbar(1, false, true)).toBe(true)
  })
})
