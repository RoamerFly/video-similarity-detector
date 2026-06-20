import type { Tone } from '@/types/ui'

export type VideoRelation =
  | 'identical'
  | 'identical_file'
  | 'a_contains_b'
  | 'b_contains_a'
  | 'partial_overlap'
  | 'similar'
  | 'different'
  | 'near_duplicate_or_same_content'
  | 'B_is_likely_clip_of_A'
  | 'A_is_likely_clip_of_B'
  | string

export interface RelationInfo {
  label: string
  labelEn: string
  color: string
  bgColor: string
  borderColor: string
  description: string
}

const relationMap: Record<string, RelationInfo> = {
  identical: {
    label: '完全相同',
    labelEn: 'Identical',
    color: '#22c55e',
    bgColor: 'rgba(34, 197, 94, 0.15)',
    borderColor: 'rgba(34, 197, 94, 0.4)',
    description: '两个视频内容完全相同',
  },
  identical_file: {
    label: '相同文件',
    labelEn: 'Identical File',
    color: '#22c55e',
    bgColor: 'rgba(34, 197, 94, 0.15)',
    borderColor: 'rgba(34, 197, 94, 0.4)',
    description: '两个路径的文件内容完全相同',
  },
  near_duplicate_or_same_content: {
    label: '近似重复',
    labelEn: 'Near Duplicate',
    color: '#22c55e',
    bgColor: 'rgba(34, 197, 94, 0.15)',
    borderColor: 'rgba(34, 197, 94, 0.4)',
    description: '两个视频高度相似或内容近似重复',
  },
  a_contains_b: {
    label: 'A 包含 B',
    labelEn: 'A Contains B',
    color: '#2F7CFF',
    bgColor: 'rgba(47, 124, 255, 0.15)',
    borderColor: 'rgba(47, 124, 255, 0.4)',
    description: '视频 A 包含视频 B 的内容',
  },
  b_contains_a: {
    label: 'B 包含 A',
    labelEn: 'B Contains A',
    color: '#7C3AED',
    bgColor: 'rgba(124, 58, 237, 0.15)',
    borderColor: 'rgba(124, 58, 237, 0.4)',
    description: '视频 B 包含视频 A 的内容',
  },
  B_is_likely_clip_of_A: {
    label: 'B 是 A 的片段',
    labelEn: 'B is clip of A',
    color: '#EC4ED8',
    bgColor: 'rgba(236, 78, 216, 0.15)',
    borderColor: 'rgba(236, 78, 216, 0.4)',
    description: '视频 B 很可能是视频 A 的片段',
  },
  A_is_likely_clip_of_B: {
    label: 'A 是 B 的片段',
    labelEn: 'A is clip of B',
    color: '#EC4ED8',
    bgColor: 'rgba(236, 78, 216, 0.15)',
    borderColor: 'rgba(236, 78, 216, 0.4)',
    description: '视频 A 很可能是视频 B 的片段',
  },
  partial_overlap: {
    label: '部分重叠',
    labelEn: 'Partial Overlap',
    color: '#2F7CFF',
    bgColor: 'rgba(47, 124, 255, 0.15)',
    borderColor: 'rgba(47, 124, 255, 0.4)',
    description: '两个视频有部分内容重叠',
  },
  similar: {
    label: '相似',
    labelEn: 'Similar',
    color: '#f59e0b',
    bgColor: 'rgba(245, 158, 11, 0.15)',
    borderColor: 'rgba(245, 158, 11, 0.4)',
    description: '两个视频视觉内容相似',
  },
  different: {
    label: '差异较大',
    labelEn: 'Different',
    color: '#18d4ff',
    bgColor: 'rgba(24, 212, 255, 0.15)',
    borderColor: 'rgba(24, 212, 255, 0.4)',
    description: '两个视频内容差异较大',
  },
}

export function getRelationInfo(relation: VideoRelation): RelationInfo {
  return relationMap[relation] ?? {
    label: String(relation).replaceAll('_', ' '),
    labelEn: String(relation),
    color: '#94a3b8',
    bgColor: 'rgba(148, 163, 184, 0.15)',
    borderColor: 'rgba(148, 163, 184, 0.4)',
    description: '未知关系类型',
  }
}

export function relationTone(relation?: string): Tone {
  if (!relation) return 'cyan'
  if (relation.includes('near') || relation === 'identical') return 'purple'
  if (relation.includes('clip')) return 'pink'
  if (relation.includes('partial') || relation.includes('contains')) return 'blue'
  if (relation.includes('different')) return 'cyan'
  return 'purple'
}

export function determineRelation(
  aInB: number,
  bInA: number,
  threshold: number = 0.8,
  totalFramesA: number = 0,
  totalFramesB: number = 0,
  durationA: number = 0,
  durationB: number = 0,
): VideoRelation {
  const directionalGap = 0.18
  const clipThreshold = 0.65
  const aLonger = (durationA > 0 && durationB > 0 && durationA >= durationB * 1.35)
    || (totalFramesA > 0 && totalFramesB > 0 && totalFramesA >= totalFramesB * 1.35)
  const bLonger = (durationA > 0 && durationB > 0 && durationB >= durationA * 1.35)
    || (totalFramesA > 0 && totalFramesB > 0 && totalFramesB >= totalFramesA * 1.35)

  if (aLonger && bInA >= clipThreshold) return 'B_is_likely_clip_of_A'
  if (bLonger && aInB >= clipThreshold) return 'A_is_likely_clip_of_B'
  if (bInA >= 0.75 && bInA - aInB >= directionalGap) return 'B_is_likely_clip_of_A'
  if (aInB >= 0.75 && aInB - bInA >= directionalGap) return 'A_is_likely_clip_of_B'
  if (aInB >= threshold && bInA >= threshold) return 'near_duplicate_or_same_content'
  if (aInB > 0.3 || bInA > 0.3) return 'partial_overlap'
  if (aInB > 0.1 || bInA > 0.1) return 'similar'
  return 'different'
}
