import { useEffect, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import {
  fileName,
  hasTauriRuntime,
} from '@/services/backend'
import { useMergeStore } from '@/stores/mergeStore'
import { extension } from './mergeFormat'

const audioExtensions = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma'])
const videoExtensions = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv'])

export function useMergeFileDrop(onVideoPaths?: (paths: string[]) => void) {
  const [dropActive, setDropActive] = useState(false)
  const onVideoPathsRef = useRef(onVideoPaths)

  useEffect(() => {
    onVideoPathsRef.current = onVideoPaths
  }, [onVideoPaths])

  useEffect(() => {
    if (!hasTauriRuntime()) return undefined

    let dispose = () => undefined
    let disposed = false
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'enter' || event.payload.type === 'over') {
        setDropActive(true)
        return
      }
      if (event.payload.type === 'leave') {
        setDropActive(false)
        return
      }

      setDropActive(false)
      const audioPaths = event.payload.paths.filter((path) => audioExtensions.has(extension(path)))
      const videoPaths = event.payload.paths.filter((path) => videoExtensions.has(extension(path)))
      const store = useMergeStore.getState()
      if (videoPaths.length > 0) {
        if (onVideoPathsRef.current) onVideoPathsRef.current(videoPaths)
        else store.addVideos(videoPaths.map((path) => ({ path, name: fileName(path) })))
      }
      if (audioPaths.length > 0) store.addAudioFiles(audioPaths)
    }).then((unlisten) => {
      if (disposed) unlisten()
      else dispose = unlisten
    }).catch(() => undefined)

    return () => {
      disposed = true
      dispose()
    }
  }, [])

  return dropActive
}
