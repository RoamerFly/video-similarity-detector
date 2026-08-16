export type TrackWithId = { id: string }
export type TimelineItemWithTrack = { trackId: string }

/**
 * Keeps only tracks that own at least one item.  Video keeps a single first
 * track as an empty-project drop target; audio/text stay hidden until content
 * is present so the timeline does not grow placeholder rows.
 */
export function visibleTracks<
  Track extends TrackWithId,
  Item extends TimelineItemWithTrack,
>(tracks: Track[], items: Item[], keepFirstWhenEmpty = false): Track[] {
  const occupiedIds = new Set(items.map((item) => item.trackId))
  const visible = tracks.filter((track) => occupiedIds.has(track.id))
  if (visible.length > 0 || !keepFirstWhenEmpty) return visible
  return tracks.slice(0, 1)
}

export function visibleTrackIds<Track extends TrackWithId, Item extends TimelineItemWithTrack>(
  tracks: Track[],
  items: Item[],
  keepFirstWhenEmpty = false,
): string[] {
  return visibleTracks(tracks, items, keepFirstWhenEmpty).map((track) => track.id)
}
