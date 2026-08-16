interface SeekableMedia {
  currentTime: number
  seeking: boolean
  addEventListener: (type: 'seeked', listener: () => void, options?: AddEventListenerOptions) => void
}

interface PendingSeek {
  target: number | null
  tolerance: number
  listening: boolean
}

const pendingSeeks = new WeakMap<object, PendingSeek>()

/**
 * Keeps only the newest seek request while a media element is still decoding
 * the previous one. This avoids building a queue of obsolete currentTime writes
 * during fast timeline scrubbing.
 */
export function requestMediaSeek(media: SeekableMedia, target: number, tolerance = 0.008) {
  const next = Number.isFinite(target) ? Math.max(0, target) : 0
  let state = pendingSeeks.get(media as object)
  if (!state) {
    state = { target: null, tolerance, listening: false }
    pendingSeeks.set(media as object, state)
  }

  if (!media.seeking && Math.abs(media.currentTime - next) < tolerance) {
    state.target = null
    return false
  }

  state.target = next
  state.tolerance = tolerance
  if (state.listening || media.seeking) {
    listenForSeekEnd(media, state)
    return false
  }
  return flushLatestSeek(media, state, tolerance)
}

function listenForSeekEnd(media: SeekableMedia, state: PendingSeek) {
  if (state.listening) return
  state.listening = true
  media.addEventListener('seeked', () => {
    state.listening = false
    if (state.target !== null) flushLatestSeek(media, state, state.tolerance)
  }, { once: true })
}

function flushLatestSeek(media: SeekableMedia, state: PendingSeek, tolerance: number) {
  const target = state.target
  state.target = null
  if (target === null || Math.abs(media.currentTime - target) < tolerance) return false
  listenForSeekEnd(media, state)
  media.currentTime = target
  return true
}
