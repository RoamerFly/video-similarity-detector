import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const desktopDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktopDir, '..')

const routes = [
  { id: 'page1_analyze_page', route: '/', baseline: 'page/page1_analyze_page.png', title: '分析任务' },
  { id: 'page2_results_page', route: '/results', baseline: 'page/page2_results_page.png', title: '结果总览' },
  { id: 'page3_reports_page', route: '/reports', baseline: 'page/page3_reports_page.png', title: '报告中心' },
  { id: 'page4_settings_page', route: '/settings', baseline: 'page/page4_settings_page.png', title: '设置' },
]

const options = parseArgs(process.argv.slice(2))
const targetUrl = options.url ?? process.env.VISUAL_QA_URL ?? 'http://127.0.0.1:5173/'
const viewport = {
  width: Number(options.width ?? process.env.VISUAL_QA_WIDTH ?? 1586),
  height: Number(options.height ?? process.env.VISUAL_QA_HEIGHT ?? 992),
}
const maxDiffRatio = Number(options.maxDiffRatio ?? process.env.VISUAL_QA_MAX_DIFF_RATIO ?? 0.03)
const mockTauri = options.realTauri !== true
const headed = options.headed === true || process.env.HEADED === '1'
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const outputDir = path.resolve(desktopDir, 'visual-qa-output', timestamp)

const { chromium, PNG, pixelmatch } = await loadDependencies()

fs.mkdirSync(outputDir, { recursive: true })

const browser = await chromium.launch({ headless: !headed })
const context = await browser.newContext({
  viewport,
  deviceScaleFactor: 1,
  colorScheme: 'dark',
})
const page = await context.newPage()

const consoleMessages = []
const pageErrors = []
page.on('console', (message) => {
  consoleMessages.push({ type: message.type(), text: message.text() })
})
page.on('pageerror', (error) => {
  pageErrors.push(error.stack || error.message)
})

if (mockTauri) {
  await installTauriMock(page)
}

const results = []

for (const route of routes) {
  const beforeErrorCount = pageErrors.length
  const beforeConsoleCount = consoleMessages.length
  const url = routeUrl(targetUrl, route.route)
  const actualPath = path.join(outputDir, `${route.id}.actual.png`)
  const diffPath = path.join(outputDir, `${route.id}.diff.png`)
  const baselinePath = path.resolve(repoRoot, route.baseline)

  let result
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
    await page.locator('.app-frame').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(350)

    const screenshot = await page.screenshot({ fullPage: false })
    fs.writeFileSync(actualPath, screenshot)

    const actual = PNG.sync.read(screenshot)
    const blackStats = getBlackStats(actual)

    if (!fs.existsSync(baselinePath)) {
      result = {
        ...baseResult(route, url, actualPath, diffPath, baselinePath),
        ok: false,
        reason: `baseline not found: ${baselinePath}`,
        blackStats,
      }
    } else {
      const baseline = PNG.sync.read(fs.readFileSync(baselinePath))
      if (baseline.width !== actual.width || baseline.height !== actual.height) {
        result = {
          ...baseResult(route, url, actualPath, diffPath, baselinePath),
          ok: false,
          reason: `dimension mismatch: actual ${actual.width}x${actual.height}, baseline ${baseline.width}x${baseline.height}`,
          blackStats,
        }
      } else {
        const diff = new PNG({ width: actual.width, height: actual.height })
        const diffPixels = pixelmatch(actual.data, baseline.data, diff.data, actual.width, actual.height, {
          threshold: 0.1,
          includeAA: true,
        })
        fs.writeFileSync(diffPath, PNG.sync.write(diff))
        const diffRatio = diffPixels / (actual.width * actual.height)
        const routeErrors = pageErrors.slice(beforeErrorCount)

        result = {
          ...baseResult(route, url, actualPath, diffPath, baselinePath),
          ok: diffRatio <= maxDiffRatio && !blackStats.isMostlyBlack && routeErrors.length === 0,
          diffPixels,
          diffRatio,
          maxDiffRatio,
          blackStats,
          pageErrors: routeErrors,
          consoleMessages: consoleMessages.slice(beforeConsoleCount),
        }
      }
    }
  } catch (error) {
    result = {
      ...baseResult(route, url, actualPath, diffPath, baselinePath),
      ok: false,
      reason: error.stack || error.message,
      pageErrors: pageErrors.slice(beforeErrorCount),
      consoleMessages: consoleMessages.slice(beforeConsoleCount),
    }
  }

  results.push(result)
  writeProgress(result)
}

await browser.close()

const report = {
  generatedAt: new Date().toISOString(),
  targetUrl,
  viewport,
  mockTauri,
  maxDiffRatio,
  outputDir,
  results,
  ok: results.every((item) => item.ok),
}

fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
fs.writeFileSync(path.join(outputDir, 'report.md'), renderMarkdown(report), 'utf8')

console.log(`\nVisual QA report: ${path.join(outputDir, 'report.md')}`)
process.exitCode = report.ok ? 0 : 1

function parseArgs(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--headed') parsed.headed = true
    else if (arg === '--real-tauri') parsed.realTauri = true
    else if (arg === '--mock-tauri') parsed.realTauri = false
    else if (arg === '--url') parsed.url = args[++index]
    else if (arg === '--width') parsed.width = args[++index]
    else if (arg === '--height') parsed.height = args[++index]
    else if (arg === '--max-diff-ratio') parsed.maxDiffRatio = args[++index]
  }
  return parsed
}

async function loadDependencies() {
  try {
    const playwright = await import('playwright')
    const pngjs = await import('pngjs')
    const pixelmatchModule = await import('pixelmatch')
    return {
      chromium: playwright.chromium,
      PNG: pngjs.PNG,
      pixelmatch: pixelmatchModule.default,
    }
  } catch (error) {
    console.error('Missing visual QA dependencies.')
    console.error('Run: npm install --save-dev playwright pixelmatch pngjs')
    console.error('Then run: npx playwright install chromium')
    console.error(error.message)
    process.exit(2)
  }
}

async function installTauriMock(page) {
  await page.addInitScript(() => {
    const samplePairs = [
      {
        video_a: 'HP.mp4',
        video_b: 'HP_Trio.mp4',
        video_a_path: 'D:\\Videos\\HP.mp4',
        video_b_path: 'D:\\Videos\\HP_Trio.mp4',
        a_in_b: 0.824,
        b_in_a: 0.912,
        symmetric_similarity: 0.87,
        relation: 'B_is_likely_clip_of_A',
        matched_segment_count: 6,
        segments: [
          { source_start: 12, source_end: 38, target_start: 3, target_end: 29, avg_similarity: 0.91, confidence: 0.88, match_count: 24 },
          { source_start: 72, source_end: 105, target_start: 48, target_end: 81, avg_similarity: 0.86, confidence: 0.82, match_count: 18 },
        ],
      },
      {
        video_a: 'INFJ.mp4',
        video_b: 'INFJ_1.mp4',
        video_a_path: 'D:\\Videos\\INFJ.mp4',
        video_b_path: 'D:\\Videos\\INFJ_1.mp4',
        a_in_b: 0.781,
        b_in_a: 0.763,
        symmetric_similarity: 0.79,
        relation: 'near_duplicate_or_same_content',
        matched_segment_count: 5,
        segments: [],
      },
      {
        video_a: 'Jk.mp4',
        video_b: 'Jk_2.mp4',
        video_a_path: 'D:\\Videos\\Jk.mp4',
        video_b_path: 'D:\\Videos\\Jk_2.mp4',
        a_in_b: 0.548,
        b_in_a: 0.622,
        symmetric_similarity: 0.91,
        relation: 'near_duplicate_or_same_content',
        matched_segment_count: 7,
        segments: [],
      },
      {
        video_a: 'Travel.mp4',
        video_b: 'Travel_cut.mp4',
        video_a_path: 'D:\\Videos\\Travel.mp4',
        video_b_path: 'D:\\Videos\\Travel_cut.mp4',
        a_in_b: 0.436,
        b_in_a: 0.687,
        symmetric_similarity: 0.62,
        relation: 'partial_overlap',
        matched_segment_count: 4,
        segments: [],
      },
      {
        video_a: 'Demo.mp4',
        video_b: 'Sample.mp4',
        video_a_path: 'D:\\Videos\\Demo.mp4',
        video_b_path: 'D:\\Videos\\Sample.mp4',
        a_in_b: 0.187,
        b_in_a: 0.224,
        symmetric_similarity: 0.34,
        relation: 'different_content',
        matched_segment_count: 2,
        segments: [],
      },
    ]

    const sampleReport = {
      timestamp: '2026-05-24T10:22:13',
      num_pairs: 28,
      summary: {
        videos: 8,
        pairs: 28,
        near: 6,
        partial: 9,
        segments: 15,
      },
      warnings: [],
      video_pairs: samplePairs,
    }

    const reports = [
      {
        id: 'report_2026_05_24',
        path: 'D:\\Reports\\report_2026_05_24.json',
        csvPath: 'D:\\Reports\\report_2026_05_24.csv',
        htmlPath: 'D:\\Reports\\report_2026_05_24.html',
        name: 'report_2026_05_24.json',
        createdAt: '2026-05-24T10:22:13',
        modifiedAt: '1779608533',
        sizeBytes: 1300234,
        videoCount: 11,
        pairCount: 55,
        warningCount: 0,
        status: '已完成',
      },
      {
        id: 'hp_compare',
        path: 'D:\\Reports\\HP 对比报告.json',
        csvPath: 'D:\\Reports\\HP 对比报告.csv',
        htmlPath: 'D:\\Reports\\HP 对比报告.html',
        name: 'HP 对比报告.json',
        createdAt: '2026-05-23T16:15:00',
        modifiedAt: '1779543300',
        sizeBytes: 820000,
        videoCount: 8,
        pairCount: 16,
        warningCount: 0,
        status: '已完成',
      },
      {
        id: 'batch_01',
        path: 'D:\\Reports\\批量检测结果_01.json',
        csvPath: 'D:\\Reports\\批量检测结果_01.csv',
        htmlPath: 'D:\\Reports\\批量检测结果_01.html',
        name: '批量检测结果_01.json',
        createdAt: '2026-05-22T14:08:00',
        modifiedAt: '1779449280',
        sizeBytes: 2310000,
        videoCount: 20,
        pairCount: 190,
        warningCount: 0,
        status: '生成中',
      },
      {
        id: 'weekly',
        path: 'D:\\Reports\\相似度分析_周报.json',
        csvPath: 'D:\\Reports\\相似度分析_周报.csv',
        htmlPath: 'D:\\Reports\\相似度分析_周报.html',
        name: '相似度分析_周报.json',
        createdAt: '2026-05-21T09:36:00',
        modifiedAt: '1779346560',
        sizeBytes: 1760000,
        videoCount: 15,
        pairCount: 105,
        warningCount: 0,
        status: '已完成',
      },
      {
        id: 'abnormal',
        path: 'D:\\Reports\\异常对比_20260520.json',
        csvPath: 'D:\\Reports\\异常对比_20260520.csv',
        htmlPath: 'D:\\Reports\\异常对比_20260520.html',
        name: '异常对比_20260520.json',
        createdAt: '2026-05-20T18:42:00',
        modifiedAt: '1779292920',
        sizeBytes: 640000,
        videoCount: 9,
        pairCount: 36,
        warningCount: 1,
        status: '失败',
      },
    ]

    const videos = [
      'HP.mp4',
      'HP_Trio.mp4',
      'INFJ.mp4',
      'INFJ_1.mp4',
      'Jk.mp4',
      'Jk_2.mp4',
      'Travel.mp4',
      'Travel_cut.mp4',
    ].map((name, index) => ({
      path: `D:\\Videos\\Input\\${name}`,
      name,
      extension: 'mp4',
      sizeBytes: 64_000_000 + index * 3_100_000,
      sizeMb: 61 + index * 2.8,
    }))

    window.isTauri = true
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => {},
    }
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main' },
        currentWebviewWindow: { label: 'main' },
      },
      callbacks: {},
      transformCallback: (callback) => {
        const id = Math.floor(Math.random() * 1_000_000)
        window.__TAURI_INTERNALS__.callbacks[id] = callback
        return id
      },
      unregisterCallback: (id) => {
        delete window.__TAURI_INTERNALS__.callbacks[id]
      },
      convertFileSrc: (filePath) => filePath,
      invoke: async (cmd) => {
        if (cmd === 'get_app_info') {
          return {
            projectRoot: 'D:\\Agent\\Project\\video-containment-detector',
            defaultVideoDir: 'D:\\Videos\\Input',
            defaultCacheDir: 'data',
            defaultOutputDir: 'data\\reports',
            appName: 'video-similarity-desktop',
            version: '1.0.0',
          }
        }
        if (cmd === 'scan_videos') return videos
        if (cmd === 'list_reports') return reports
        if (cmd === 'read_report') return sampleReport
        if (cmd === 'run_batch_compare' || cmd === 'run_compare_two') {
          return {
            success: true,
            stdout: 'mock visual QA report generated',
            stderr: '',
            reportPath: reports[0].path,
            csvPath: reports[0].csvPath,
            htmlPath: reports[0].htmlPath,
            json: sampleReport,
          }
        }
        if (cmd === 'check_environment') {
          return {
            pythonOk: true,
            pythonVersion: '3.11.9',
            projectOk: true,
            scriptsOk: true,
            outputOk: true,
            message: '环境正常',
          }
        }
        return null
      },
    }
  })
}

function routeUrl(base, route) {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  if (route === '/') return normalizedBase
  return new URL(route.replace(/^\//, ''), normalizedBase).toString()
}

function baseResult(route, url, actualPath, diffPath, baselinePath) {
  return {
    id: route.id,
    title: route.title,
    route: route.route,
    url,
    baselinePath,
    actualPath,
    diffPath,
  }
}

function getBlackStats(png) {
  let totalLuma = 0
  let darkPixels = 0
  const totalPixels = png.width * png.height

  for (let index = 0; index < png.data.length; index += 4) {
    const r = png.data[index]
    const g = png.data[index + 1]
    const b = png.data[index + 2]
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    totalLuma += luma
    if (luma < 8) darkPixels += 1
  }

  const avgLuma = totalLuma / totalPixels
  const darkRatio = darkPixels / totalPixels
  return {
    avgLuma,
    darkRatio,
    isMostlyBlack: avgLuma < 8 && darkRatio > 0.96,
  }
}

function writeProgress(result) {
  const status = result.ok ? 'PASS' : 'FAIL'
  const diff = typeof result.diffRatio === 'number' ? ` diff=${(result.diffRatio * 100).toFixed(2)}%` : ''
  const black = result.blackStats?.isMostlyBlack ? ' mostly-black' : ''
  const reason = result.reason ? ` reason=${result.reason}` : ''
  console.log(`${status} ${result.id}${diff}${black}${reason}`)
}

function renderMarkdown(report) {
  const lines = [
    '# Visual QA Report',
    '',
    `- Target: ${report.targetUrl}`,
    `- Viewport: ${report.viewport.width}x${report.viewport.height}`,
    `- Tauri mock: ${report.mockTauri ? 'enabled' : 'disabled'}`,
    `- Max diff ratio: ${(report.maxDiffRatio * 100).toFixed(2)}%`,
    `- Overall: ${report.ok ? 'PASS' : 'FAIL'}`,
    '',
    '| Page | Result | Diff | Mostly black | Actual | Diff image |',
    '| --- | --- | ---: | --- | --- | --- |',
  ]

  for (const result of report.results) {
    const diff = typeof result.diffRatio === 'number' ? `${(result.diffRatio * 100).toFixed(2)}%` : '-'
    lines.push(
      `| ${result.title} | ${result.ok ? 'PASS' : 'FAIL'} | ${diff} | ${result.blackStats?.isMostlyBlack ? 'yes' : 'no'} | ${result.actualPath} | ${result.diffPath} |`
    )
  }

  lines.push('', '## Notes', '')
  for (const result of report.results) {
    if (result.reason || result.pageErrors?.length) {
      lines.push(`### ${result.title}`, '')
      if (result.reason) lines.push(`- Reason: ${result.reason}`)
      for (const error of result.pageErrors ?? []) {
        lines.push(`- Page error: ${String(error).split('\n')[0]}`)
      }
      lines.push('')
    }
  }

  return `${lines.join('\n')}\n`
}
