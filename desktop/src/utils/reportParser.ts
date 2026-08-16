import { pathStatus, readReportOverview, readTextFile, siblingPath } from '@/services/backend'
import {
  parseCsvReport,
  parseJsonValue,
  ReportParseError,
  stringifyError,
  type BatchReport,
  type ReportSourcePaths,
} from './reportParserCore'

// 纯解析逻辑（类型 + parseJsonReport/parseJsonValue/parseCsvReport/summarizePairs/格式化函数等）
// 全部来自 reportParserCore，供结果页与对比页共享，保持导出面不变。
export * from './reportParserCore'

// —— 报告加载优化 ——
// 批量报告的体积几乎全部由每个视频对的逐帧匹配明细（matches_a_to_b / matches_b_to_a）
// 构成（实测约 97%）。结果总览页只展示统计、片段与窗口，并不需要逐帧明细。因此这里
// 通过后端的 read_report_overview 直接读取「已剥离逐帧明细」的对象（体积缩小数十倍），
// 主线程只需做轻量的归一化；逐帧明细由对比页在打开具体视频对时按需懒加载。
export async function loadBatchReport(paths: ReportSourcePaths, threshold = 0.65): Promise<BatchReport> {
  const jsonPath = paths.reportJson?.trim()
  const csvPath = paths.reportCsv?.trim() || (jsonPath ? siblingPath(jsonPath, 'csv') : '')
  const errors: string[] = []
  let sawExistingFile = false

  if (jsonPath) {
    try {
      if (!await isReadableFile(jsonPath)) {
        errors.push(`JSON: 报告文件尚未生成 ${jsonPath}`)
      } else {
        sawExistingFile = true
        const data = await readReportOverview(jsonPath)
        return parseJsonValue(data, jsonPath, threshold)
      }
    } catch (error) {
      errors.push(`JSON: ${stringifyError(error)}`)
    }
  }

  if (csvPath) {
    try {
      if (!await isReadableFile(csvPath)) {
        errors.push(`CSV: 报告文件尚未生成 ${csvPath}`)
      } else {
        sawExistingFile = true
        const content = await readTextFile(csvPath)
        return parseCsvReport(content, csvPath, threshold)
      }
    } catch (error) {
      errors.push(`CSV: ${stringifyError(error)}`)
    }
  }

  if (!sawExistingFile && (jsonPath || csvPath)) {
    throw new ReportParseError('尚未找到可读取的报告文件，完成分析后会自动显示结果。', jsonPath || csvPath)
  }

  throw new ReportParseError(
    errors.length > 0 ? `报告解析失败：${errors.join('；')}` : '尚未运行分析，请先选择视频目录并开始分析。',
    jsonPath || csvPath,
  )
}

async function isReadableFile(path: string) {
  const status = await pathStatus(path)
  return status.exists && status.isFile
}
