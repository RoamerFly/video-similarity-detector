import { describe, expect, it } from 'vitest'
import { visibleTrackIds, visibleTracks } from './trackVisibility'

const tracks = [
  { id: 'track-1', name: '线 1' },
  { id: 'track-2', name: '线 2' },
  { id: 'track-3', name: '线 3' },
]

describe('visibleTracks', () => {
  it('keeps one video guide row for an empty project', () => {
    expect(visibleTrackIds(tracks, [], true)).toEqual(['track-1'])
  })

  it('hides empty backup tracks while preserving track order', () => {
    expect(visibleTrackIds(tracks, [{ trackId: 'track-3' }, { trackId: 'track-1' }])).toEqual(['track-1', 'track-3'])
    expect(visibleTracks(tracks, [{ trackId: 'track-2' }])).toEqual([tracks[1]])
  })

  it('does not add an empty audio or text row', () => {
    expect(visibleTrackIds(tracks, [])).toEqual([])
  })
})
