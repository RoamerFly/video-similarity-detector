import { createElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { translateMultiline, translateText } from './messages'
import { translateNode } from './useI18n'
import { runtimeUpdatePrompt } from '@/components/RuntimeSettingsCard'
import { mergeRuntimeUpdatePrompt } from '@/components/MergeRuntimeSettingsCard'
import { clipModelUpdatePrompt } from '@/pages/SettingsPage'

describe('English translations for shared and merge UI', () => {
  it('translates merge controls and accessibility attributes', () => {
    const node = translateNode(
      createElement('button', {
        title: '右键新建或管理文本线',
        'aria-label': '一键对齐时间线',
      }, '保存属性'),
      'en-US',
    ) as ReactElement<{ children?: ReactNode; title?: string; 'aria-label'?: string }>

    expect(node.props.children).toEqual(['Save Properties'])
    expect(node.props.title).toBe('Right-click to create or manage a text track')
    expect(node.props['aria-label']).toBe('Align timeline')
  })

  it('translates dynamic list suffixes and multiline confirmation text', () => {
    expect(translateText('- 以及另外 3 个文件', 'en-US')).toBe('- and 3 more files')

    const warning = translateMultiline([
      '尚有文件在移动，是否确认退出？',
      '当前文件：sample.mp4',
      '- 以及另外 3 个文件',
    ].join('\n'), 'en-US')

    expect(warning).toContain('Files are still being moved. Exit anyway?')
    expect(warning).toContain('Current file: sample.mp4')
    expect(warning).toContain('- and 3 more files')
    expect(warning).not.toMatch(/[\u3400-\u9fff]/)
  })

  it('translates analysis capsule status and dynamic report/log summaries', () => {
    expect(translateText('分析状态与日志', 'en-US')).toBe('Analysis Status and Logs')
    expect(translateText('分析报告已生成（4 个文件）', 'en-US')).toBe('Analysis report generated (4 files)')
    expect(translateText('已保留最近 10 行，省略 2 行', 'en-US')).toBe('Kept the latest 10 lines; omitted 2 lines')
    expect(translateText('为保持界面流畅，仅渲染当前窗口最近 10 行；复制仍包含全部保留日志。', 'en-US')).toContain('Only the latest 10 log lines')
  })

  it('keeps runtime reinstall confirmations fully localized', () => {
    const translate = (value: string) => translateText(value, 'en-US')
    const check = {
      installed: true,
      updateAvailable: true,
      comparisonAvailable: true,
      assetName: 'runtime.zip',
      installedVersion: '1.2.0',
      remoteVersion: '1.3.0',
      localSha256: 'a'.repeat(64),
      remoteSha256: 'b'.repeat(64),
      message: '',
    }

    expect(runtimeUpdatePrompt(check, translate)).toBe('An AI runtime update is available (Local v1.2.0, GitHub v1.3.0) (Local SHA-256 aaaaaaaaaaaa…, Remote bbbbbbbbbbbb…). Update it?')
    expect(mergeRuntimeUpdatePrompt(check, translate)).toBe('A video merge runtime update is available (Local v1.2.0, GitHub v1.3.0) (Local SHA-256 aaaaaaaaaaaa…, Remote bbbbbbbbbbbb…). Update it?')
  })

  it('translates native prompts and synchronized report messages without Chinese', () => {
    const cases = [
      '确认清理选中的 3 个缓存项目吗？此操作不可撤销，但不会删除原始视频。',
      '将下载 GPU 安装包，完成后自动退出并覆盖安装到：',
      '重命名视频文件（2/4）：',
      '请输入新的文件名（包含扩展名）：',
      '确定要从报告中删除与该视频相关的 2 条记录吗？',
      '已删除 2 条与视频 sample.mp4 相关的记录。',
      '当前结果没有对应的报告文件，无法同步删除记录。',
      '已删除 2 个文件，但同步报告记录失败：当前结果没有对应的报告文件，无法同步删除记录。',
      '文件已删除，但同步报告记录失败：当前结果没有对应的报告文件，无法同步删除记录。',
      '已删除视频文件：sample.mp4，但同步报告记录失败：当前结果没有对应的报告文件，无法同步删除记录。',
      '已删除视频文件：sample.mp4，并同步删除相关报告记录。',
      '报告中没有与该视频相关的记录。',
      '删除与该视频相关记录',
    ]

    for (const value of cases) {
      expect(translateMultiline(value, 'en-US')).not.toMatch(/[\u3400-\u9fff]/)
    }

    expect(clipModelUpdatePrompt({
      installed: true,
      updateAvailable: false,
      comparisonAvailable: true,
      assetName: 'clip.zip',
      installedVersion: 'main',
      remoteVersion: 'main',
      message: '',
    }, (value) => translateText(value, 'en-US'))).not.toMatch(/[\u3400-\u9fff]/)
  })

  it('translates complete dynamic deletion confirmations without Chinese', () => {
    const tm = (value: string) => translateMultiline(value, 'en-US')
    const confirmations = [
      '确认清理选中的 3 个任务缓存项目吗？原始视频不会被删除。',
      '重做“动态抽帧与特征提取”会重置该阶段及其后续阶段进度，是否继续？',
      '删除选中路径：确认永久删除 2 个文件吗？此操作不可撤销。',
      '保留选中路径，删除其他路径：确认永久删除 1 个文件吗？此操作不可撤销。',
      '删除该路径：确认永久删除 1 个文件吗？此操作不可撤销。',
      '确定永久删除视频文件“sample.mp4”吗？\nC:\\Videos\\sample.mp4\n\n此操作不可撤销。',
      '确定永久删除当前报告全部结果关联的 2 个视频文件吗？\nfirst.mp4、second.mp4\n\n文件删除后无法恢复，删除成功的视频对应结果记录也会从当前视图移除。',
      '确定永久删除 2 个视频文件吗？\nfirst.mp4、second.mp4 等\n\n文件删除后无法恢复，对应结果记录也会从当前视图移除。',
      '报告仅更新了 1/2 条相关记录。 报告文件可能已被外部修改，请刷新报告后重试。',
    ]

    for (const value of confirmations) {
      expect(tm(value)).not.toMatch(/[\u3400-\u9fff]/)
    }

    expect(tm(confirmations[2])).toBe('Delete Selected Paths: Permanently delete 2 files? This action cannot be undone.')
    expect(tm(confirmations[3])).toContain('Keep Selected, Delete Others: Permanently delete 1 file')
    expect(tm(confirmations[4])).toContain('Delete This Path: Permanently delete 1 file')
    expect(tm(confirmations[5])).toBe('Permanently delete video file "sample.mp4"?\nC:\\Videos\\sample.mp4\n\nThis action cannot be undone.')
    expect(tm(confirmations[6])).toContain('Permanently delete 2 video files related to all results in the current report?')
    expect(tm(confirmations[7])).toContain('Permanently delete 2 video files?')
    expect(tm(confirmations[8])).toBe('Only 1 of 2 related records were updated. The report file may have been modified externally. Refresh the report and try again.')
  })
})
