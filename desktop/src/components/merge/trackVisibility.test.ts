import { describe, expect, it } from 'vitest'
import { visibleTrackIds, visibleTracks } from './trackVisibility'

const tracks = [
  { id: 'track-1', name: '线 1' },
  { id: 'track-2', name: '线 2' },
  { id: 'track-3', name: '线 3' },
]

describe('visibleTracks', () => {
  it('keeps all explicitly-created video rows for an empty project', () => {
    expect(visibleTrackIds(tracks)).toEqual(['track-1', 'track-2', 'track-3'])
  })

  it('preserves every track and its creation order even when it is empty', () => {
    expect(visibleTrackIds(tracks)).toEqual(['track-1', 'track-2', 'track-3'])
    expect(visibleTracks(tracks)).toEqual(tracks)
  })

  it('keeps empty audio or text rows as usable drop targets', () => {
    expect(visibleTrackIds(tracks)).toEqual(['track-1', 'track-2', 'track-3'])
  })
})
