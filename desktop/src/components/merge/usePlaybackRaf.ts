import { useEffect, useRef } from 'react'

interface UsePlaybackRafOptions {
  playing: boolean
  duration: number
  getInitialTime: () => number
  onFrame: (time: number, timestamp: number) => void
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
    const startedAt = performance.now()
    const initialTime = getInitialTime()
    const tick = (timestamp: number) => {
      const time = initialTime + (timestamp - startedAt) / 1000
      if (time >= duration) {
        callbacksRef.current.onFrame(duration, timestamp)
        callbacksRef.current.onEnd()
        return
      }
      callbacksRef.current.onFrame(time, timestamp)
      frameRef.current = window.requestAnimationFrame(tick)
    }
    frameRef.current = window.requestAnimationFrame(tick)
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [duration, getInitialTime, playing])
}
