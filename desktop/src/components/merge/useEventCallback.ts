import { useCallback, useEffect, useRef } from 'react'

/**
 * Keeps an event handler's identity stable without retaining an old render's
 * project state. This lets memoized timeline rows avoid rerendering merely
 * because their page owner rendered for unrelated inspector state.
 */
export function useEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
) {
  const callbackRef = useRef(callback)

  useEffect(() => {
    callbackRef.current = callback
  })

  return useCallback((...args: Args) => callbackRef.current(...args), [])
}
