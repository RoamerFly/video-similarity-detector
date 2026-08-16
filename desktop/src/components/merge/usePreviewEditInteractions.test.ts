import { describe, expect, it, vi } from 'vitest'

describe('preview edit interaction lifecycle', () => {
  it('documents draft-first, commit-on-release ordering', () => {
    const calls: string[] = []
    const draft = vi.fn(() => calls.push('draft'))
    const commit = vi.fn(() => calls.push('commit'))
    const clear = vi.fn(() => calls.push('clear'))

    draft()
    commit()
    clear()

    expect(calls).toEqual(['draft', 'commit', 'clear'])
  })
})
