import { describe, expect, it } from 'vitest'

import type { BatchReport, ReportPair } from '@/utils/reportParser'
import {
  applyReportDeletionResult,
  findPairsForDeletedPaths,
  normalizeVideoIdentity,
  pairContainsDeletedPath,
  reportPairIdentity,
  reportPairVideoPaths,
  resolveReportVideoPath,
} from './reportRecordDeletion'

function pair(overrides: Partial<ReportPair> = {}): ReportPair {
  return {
    id: 'pair-1',
    completedAt: '',
    videoA: 'clip.mp4',
    videoB: 'other.mp4',
    videoAPath: 'D:/videos/one/clip.mp4',
    videoBPath: 'D:/videos/two/other.mp4',
    aInB: null,
    bInA: null,
    symmetricSimilarity: null,
    avgSimilarityAToB: null,
    avgSimilarityBToA: null,
    relation: 'near_duplicate',
    matchedSegmentCount: 0,
    matchedSegments: [],
    windowSimilarity: [],
    frameMatches: [],
    matchesAToBTotal: 0,
    matchesBToATotal: 0,
    totalFramesA: 0,
    totalFramesB: 0,
    durationA: 0,
    durationB: 0,
    reportSchemaVersion: null,
    containmentScoringVersion: null,
    raw: {},
    ...overrides,
  }
}

function report(pairs: ReportPair[]): BatchReport {
  return {
    timestamp: '',
    warnings: [],
    pairs,
    summary: { videos: 0, pairs: pairs.length, highPairs: 0, partialPairs: 0, segments: 0 },
    sourcePath: 'D:/reports/report.json',
    sourceFormat: 'json',
  }
}

describe('report video deletion identities', () => {
  it('resolves relative paths while retaining their directory', () => {
    expect(resolveReportVideoPath('sub/clip.mp4', 'clip.mp4', 'D:/videos'))
      .toBe('D:/videos/sub/clip.mp4')
    expect(resolveReportVideoPath('clip.mp4', 'fallback.mp4', 'D:/videos'))
      .toBe('D:/videos/clip.mp4')
  })

  it('normalizes Windows case, separators, dot segments and extended prefixes', () => {
    expect(normalizeVideoIdentity(String.raw`\\?\D:\Videos\One\..\clip.mp4`))
      .toBe('d:/videos/clip.mp4')
    expect(normalizeVideoIdentity('D:/Videos/clip.mp4'))
      .toBe('d:/videos/clip.mp4')
  })

  it('does not match another directory with the same filename', () => {
    const first = pair()
    const second = pair({
      id: 'pair-2',
      videoAPath: 'D:/videos/three/clip.mp4',
      videoBPath: 'D:/videos/four/other.mp4',
    })
    expect(findPairsForDeletedPaths([first, second], [String.raw`d:\videos\one\CLIP.mp4`], 'D:/videos').map((item) => item.id))
      .toEqual(['pair-1'])
  })

  it('includes all duplicate group paths, including the third and later paths', () => {
    const duplicate = pair({
      relation: 'identical_file',
      raw: {
        analysis_mode: 'duplicate_file',
        duplicate_group_paths: [
          'D:/duplicates/one.mp4',
          'D:/duplicates/two.mp4',
          'D:/duplicates/three.mp4',
        ],
      },
    })
    expect(reportPairVideoPaths(duplicate, 'D:/videos')).toEqual(expect.arrayContaining([
      'D:/duplicates/one.mp4',
      'D:/duplicates/two.mp4',
      'D:/duplicates/three.mp4',
    ]))
    expect(pairContainsDeletedPath(duplicate, ['d:/duplicates/THREE.mp4'], 'D:/videos')).toBe(true)
  })

  it('returns only pairs touched by successfully deleted paths, supporting partial deletion', () => {
    const first = pair()
    const second = pair({ id: 'pair-2', videoAPath: 'D:/videos/three/clip.mp4' })
    expect(findPairsForDeletedPaths([first, second], ['D:/videos/one/clip.mp4'], 'D:/videos').map((item) => item.id))
      .toEqual(['pair-1'])
    expect(findPairsForDeletedPaths([first, second], [], 'D:/videos')).toEqual([])
  })

  it('keeps original report identities for update_report_entries', () => {
    const value = pair({ videoAPath: 'relative/clip.mp4' })
    expect(reportPairIdentity(value)).toEqual({
      videoA: 'clip.mp4',
      videoB: 'other.mp4',
      videoAPath: 'relative/clip.mp4',
      videoBPath: 'D:/videos/two/other.mp4',
    })
  })

  it('does not change report state when backend persistence removes fewer rows', () => {
    const current = report([pair()])
    const applied = applyReportDeletionResult(current, current.pairs, 0, 0.65)
    expect(applied.success).toBe(false)
    expect(applied.report).toBeNull()
    expect(current.pairs).toHaveLength(1)
  })

  it('does not change report state when backend persistence removes more rows', () => {
    const current = report([pair()])
    const applied = applyReportDeletionResult(current, current.pairs, 2, 0.65)
    expect(applied.success).toBe(false)
    expect(applied.report).toBeNull()
    expect(applied.error).toContain('2/1')
    expect(current.pairs).toHaveLength(1)
  })

  it('removes all affected pairs and recalculates the summary after persistence succeeds', () => {
    const current = report([pair(), pair({ id: 'pair-2', videoAPath: 'D:/videos/three/clip.mp4' })])
    const affected = findPairsForDeletedPaths(current.pairs, ['D:/videos/one/clip.mp4'], 'D:/videos')
    const applied = applyReportDeletionResult(current, affected, 1, 0.65)
    expect(applied.success).toBe(true)
    expect(applied.report?.pairs.map((item) => item.id)).toEqual(['pair-2'])
    expect(applied.report?.summary.pairs).toBe(1)
  })
})
