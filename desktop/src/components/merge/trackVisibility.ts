export type TrackWithId = { id: string }
/**
 * Timeline tracks are explicit user-created resources.  In particular, an
 * empty audio/video line must stay visible after it is created so it can be a
 * drop target (and so it can be removed again from its context menu).
 */
export function visibleTracks<
  Track extends TrackWithId,
>(tracks: Track[]): Track[] {
  return tracks
}

export function visibleTrackIds<Track extends TrackWithId>(
  tracks: Track[],
): string[] {
  return visibleTracks(tracks).map((track) => track.id)
}
