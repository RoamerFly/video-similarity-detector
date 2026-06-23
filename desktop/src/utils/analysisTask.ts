import type { AnalysisTaskRecord, AnalysisTaskStage, AnalysisTaskStageId } from '@/services/backend'

export const analysisTaskStageDefinitions: Array<Pick<AnalysisTaskStage, 'id' | 'label' | 'weight'>> = [
  { id: 'scan', label: '扫描与码流校验', weight: 12 },
  { id: 'cache', label: '检查可复用缓存', weight: 8 },
  { id: 'features', label: '动态抽帧与特征提取', weight: 35 },
  { id: 'candidate', label: '候选视频粗筛', weight: 8 },
  { id: 'compare', label: '视频两两比较', weight: 30 },
  { id: 'report', label: '生成分析报告', weight: 7 },
]

export function analysisTaskStatusLabel(task: AnalysisTaskRecord) {
  if (task.status === 'created') return '等待启动'
  if (task.status === 'preparing') return '正在准备'
  if (task.status === 'completed') return '已完成'
  if (task.status === 'failed') return '异常中断，可继续'
  if (task.status === 'paused') return '已暂停，可继续'
  if (task.status === 'running') return '正在运行'
  if (task.status === 'staged') return '阶段完成，待继续'
  return '未完成'
}

export function analysisTaskStatusClass(task: AnalysisTaskRecord, isActive = false) {
  if (isActive || task.status === 'running') return 'is-running'
  if (task.status === 'preparing') return 'is-preparing'
  if (task.status === 'completed') return 'is-completed'
  if (task.status === 'failed') return 'is-failed'
  if (task.status === 'paused' || task.status === 'staged') return 'is-paused'
  if (task.status === 'created') return 'is-created'
  return 'is-unknown'
}

export function analysisTaskStages(task: AnalysisTaskRecord): AnalysisTaskStage[] {
  const current = new Map((task.stages ?? []).map((stage) => [stage.id, stage]))
  return analysisTaskStageDefinitions.map((definition) => ({
    status: 'pending',
    progress: 0,
    startedAt: '',
    completedAt: '',
    elapsedMs: 0,
    message: '等待前置阶段完成',
    ...definition,
    ...current.get(definition.id),
  }))
}

export function canStartAnalysisStage(task: AnalysisTaskRecord, stageId: AnalysisTaskStageId) {
  const stages = analysisTaskStages(task)
  const index = stages.findIndex((stage) => stage.id === stageId)
  if (index < 0) return false
  return stages.slice(0, index).every((stage) => stage.status === 'completed')
}

export function nextPendingAnalysisStage(task: AnalysisTaskRecord) {
  return analysisTaskStages(task).find((stage) => stage.status !== 'completed') ?? null
}

export function formatStageElapsed(stage: AnalysisTaskStage, now = Date.now()) {
  let elapsedMs = Math.max(0, stage.elapsedMs || 0)
  if (stage.status === 'running' && stage.startedAt) {
    const startedAt = new Date(stage.startedAt).getTime()
    if (Number.isFinite(startedAt)) elapsedMs += Math.max(0, now - startedAt)
  }
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}时${minutes}分${seconds}秒`
  if (minutes > 0) return `${minutes}分${seconds}秒`
  return `${seconds}秒`
}
