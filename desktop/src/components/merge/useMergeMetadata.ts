import { useEffect, useMemo, useState } from 'react'

import {
  normalizeBackendError,
  probeVideoMetadata,
  type VideoMetadata,
} from '@/services/backend'
import type { MergeQueueItem } from '@/stores/mergeStore'
import { normalizePath } from './mergeFormat'

const metadataCache = new Map<string, VideoMetadata>()
const metadataCacheLimit = 512

function cacheMetadata(item: VideoMetadata) {
  const key = normalizePath(item.path)
  metadataCache.delete(key)
  metadataCache.set(key, item)
  while (metadataCache.size > metadataCacheLimit) {
    const oldest = metadataCache.keys().next().value
    if (oldest === undefined) return
    metadataCache.delete(oldest)
  }
}

interface UseMergeMetadataOptions {
  items: MergeQueueItem[]
  projectRoot: string
  pythonPath: string
  onError: (message: string) => void
}

export function useMergeMetadata({
  items,
  projectRoot,
  pythonPath,
  onError,
}: UseMergeMetadataOptions) {
  const [metadata, setMetadata] = useState<Record<string, VideoMetadata>>(
    () => Object.fromEntries(metadataCache),
  )
  const videoPathKey = useMemo(
    () => Array.from(new Set(items.map((item) => normalizePath(item.path)))).sort().join('|'),
    [items],
  )

  useEffect(() => {
    const paths = Array.from(new Set(items.map((item) => item.path)))
    const missing = paths.filter((path) => !metadataCache.has(normalizePath(path)))
    if (missing.length === 0) return undefined

    let alive = true
    probeVideoMetadata(missing, undefined, projectRoot, pythonPath)
      .then((rows) => {
        ;(rows ?? []).forEach(cacheMetadata)
        if (alive) setMetadata(Object.fromEntries(metadataCache))
      })
      .catch((error) => {
        if (alive) onError(normalizeBackendError(error))
      })

    return () => {
      alive = false
    }
  }, [items, onError, projectRoot, pythonPath, videoPathKey])

  return {
    metadata,
    probing: items.some((item) => !metadata[normalizePath(item.path)]),
  }
}
