import { useEffect, useRef } from 'react'

interface UsePlaybackRafOptions {
  playing: boolean
  duration: number
  getInitialTime: () => number
  onFrame: (time: number, timestamp: number) => boolean | void
  onEnd: () => void
}

/** Owns only the monotonic RAF clock; media selection and sync stay injectable. */
export function usePlaybackRaf({ playing, duration, getInitialTime, onFrame, onEnd }: UsePlaybackRafOptions) {
  const frameRef = useRef<number | null>(null)
  const callbacksRef = useRef({ onFrame, onEnd })

  useEffect(() => {
    callbacksRef.current = { onFrame, onEnd }
  }, [onEnd, onFrame])

  useEffect(() => {
    if (!playing) return undefined
    let startedAt = performance.now()
    const initialTime = getInitialTime()
    let acceptedTime = initialTime
    const tick = (timestamp: number) => {
      const time = initialTime + (timestamp - startedAt) / 1000
      const boundedTime = Math.min(time, duration)
      const accepted = callbacksRef.current.onFrame(boundedTime, timestamp)
      if (accepted === false) {
        // Rebase the monotonic clock while media decodes. Resuming from the
        // last displayed frame prevents a blank clip from consuming time.
        startedAt = timestamp - (acceptedTime - initialTime) * 1000
      } else {
        acceptedTime = boundedTime
        if (boundedTime >= duration) {
          callbacksRef.current.onEnd()
          return
        }
      }
      frameRef.current = window.requestAnimationFrame(tick)
    }
    frameRef.current = window.requestAnimationFrame(tick)
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [duration, getInitialTime, playing])
}
