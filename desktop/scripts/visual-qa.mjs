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
  { id: 'page4_settings_page', route: '/settings', baseline: 'page/page4_settings_page.png', title: '设置' },
  { id: 'page5_merge_page', route: '/merge', baseline: null, title: '视频合并' },
  { id: 'page5_merge_single_page', route: '/merge?scenario=single', baseline: null, title: '视频合并（单轨）' },
]

const options = parseArgs(process.argv.slice(2))
const targetUrl = options.url ?? process.env.VISUAL_QA_URL ?? 'http://127.0.0.1:5173/'
const selectedRoutes = options.route === 'merge'
  ? routes.filter((route) => route.route.startsWith('/merge'))
  : options.route
    ? routes.filter((route) => route.route === options.route || route.id === options.route)
    : routes
if (selectedRoutes.length === 0) {
  throw new Error(`Unknown visual QA route: ${options.route}`)
}
const viewport = {
  width: Number(options.width ?? process.env.VISUAL_QA_WIDTH ?? 1586),
  height: Number(options.height ?? process.env.VISUAL_QA_HEIGHT ?? 992),
}
const maxDiffRatio = Number(options.maxDiffRatio ?? process.env.VISUAL_QA_MAX_DIFF_RATIO ?? 0.03)
const navigationTimeout = Number(options.navigationTimeout ?? process.env.VISUAL_QA_NAVIGATION_TIMEOUT ?? 45000)
const mockTauri = options.realTauri !== true
const headed = options.headed === true || process.env.HEADED === '1'
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const outputDir = path.resolve(desktopDir, 'visual-qa-output', timestamp)

const { chromium, PNG, pixelmatch } = await loadDependencies()
const managedDevServer = await startManagedDevServerIfNeeded(targetUrl, options)

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
  await installTauriMock(page, options.language)
}

if (mockTauri && selectedRoutes.some((route) => route.route.startsWith('/merge'))) {
  await page.addInitScript(() => {
    const video = (id, name, trackId, startTime) => ({
      id, path: `D:\\VisualQA\\${name}`, name, trackId, startTime, trimStart: 0, trimEnd: 8,
      muted: false, volume: 1, rotation: 0, cropEnabled: false, cropX: 0, cropY: 0, cropWidth: 1920, cropHeight: 1080,
      layoutCustom: false, layoutX: 0, layoutY: 0, layoutWidth: 1, layoutHeight: 1,
    })
    const singleScenario = new URL(window.location.href).searchParams.get('scenario') === 'single'
    const state = {
      state: {
        items: singleScenario
          ? [video('qa-video-a', '主持人.mp4', 'video-track-1', 0)]
          : [video('qa-video-a', '主持人.mp4', 'video-track-1', 0), video('qa-video-b', '屏幕录制.mp4', 'video-track-2', 0)],
        audioItems: singleScenario ? [] : [{ id: 'qa-audio-a', path: 'D:\\VisualQA\\旁白.mp3', name: '旁白.mp3', trackId: 'audio-track-1', startTime: 0, trimStart: 0, trimEnd: 8 }],
        textItems: singleScenario ? [] : [{ id: 'qa-text-a', text: '多轨合并预览', trackId: 'text-track-1', startTime: 0, duration: 5, x: 0.5, y: 0.84, fontSize: 42, color: '#ffffff', backgroundColor: 'rgba(0,0,0,0.45)' }],
        videoTracks: singleScenario
          ? [{ id: 'video-track-1', name: '视频线 1' }]
          : [{ id: 'video-track-1', name: '视频线 1' }, { id: 'video-track-2', name: '视频线 2' }],
        audioTracks: [{ id: 'audio-track-1', name: '音频线 1' }], textTracks: [{ id: 'text-track-1', name: '文本线 1' }],
        settings: { outputDir: 'data/merged', outputName: 'visual-qa-merge', width: 1920, height: 1080, fps: 30, includeAudio: true, canvasBackground: 'black', fitMode: 'contain', snapToVideos: true, videoEncoder: 'h264', rateControl: 'quality', crf: 23, videoBitrate: 4000, twoPass: false, encoderPreset: 'medium', audioBitrate: 192 },
      }, version: 0,
    }
    localStorage.setItem('video-similarity-merge:v2', JSON.stringify(state))
  })
}

const results = []
const mergeMetricsByRoute = new Map()

for (const route of selectedRoutes) {
  const beforeErrorCount = pageErrors.length
  const beforeConsoleCount = consoleMessages.length
  const url = routeUrl(targetUrl, route.route)
  const actualPath = path.join(outputDir, `${route.id}.actual.png`)
  const diffPath = path.join(outputDir, `${route.id}.diff.png`)
  const baselinePath = route.baseline ? path.resolve(repoRoot, route.baseline) : null

  let result
  let mergeLayoutMetrics = null
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeout })
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
    await page.locator('.app-frame').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(350)

    if (route.route.startsWith('/merge')) {
      const singleScenario = route.route.includes('scenario=single')
      await page.locator('.timeline-video-clip').first().waitFor({ state: 'visible', timeout: 5000 })
      if (!singleScenario) {
        await page.locator('.timeline-audio-clip').first().waitFor({ state: 'visible', timeout: 5000 })
        await page.locator('.timeline-text-clip').first().waitFor({ state: 'visible', timeout: 5000 })
      }
      await page.waitForFunction(() => {
        const canvas = document.querySelector('.editor-output-canvas')
        return Boolean(canvas?.style.width && canvas.style.height)
      }, { timeout: 5000 })
      const previewBox = await page.locator('.editor-preview-screen').boundingBox()
      const previewStageBox = await page.locator('.editor-preview-stage').boundingBox()
      const canvasBox = await page.locator('.editor-output-canvas').boundingBox()
      const headerBox = await page.locator('.compact-shell .brand-header').boundingBox()
      const canvasStyle = await page.locator('.editor-output-canvas').evaluate((node) => ({
        left: node.style.left,
        top: node.style.top,
        right: node.style.right,
        bottom: node.style.bottom,
        width: node.style.width,
        height: node.style.height,
      }))
      const playerBox = await page.locator('.editor-player-controls').boundingBox()
      const previewSliderCount = await page.locator('.editor-player-controls input[type="range"]').count()
      const previewResetCount = await page.locator('.editor-preview-size-tools').count()
      const topResetCount = await page.locator('.editor-toolbar').getByRole('button', { name: '还原窗口' }).count()
      const topAdvancedCount = await page.locator('.editor-toolbar').getByRole('button', { name: '高级导出设置' }).count()
      const mergeSubtitleCount = await page.locator('.compact-shell .brand-subtitle').count()
      const timelineBox = await page.locator('.timeline-workspace').boundingBox()
      const mergePageOverflow = await page.locator('.merge-editor-page').evaluate((node) => ({
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      }))
      const zoomControlCount = await page.locator('.timeline-tool-card, .timeline-zoom-value, .timeline-zoom-input').count()
      const overlapToolbarCount = await page.locator('.editor-overlap-layout').count()
      const timelineMetrics = await page.locator('.timeline-scroll-viewport').evaluate((node) => {
        const viewport = node.getBoundingClientRect()
        const tracks = Array.from(node.querySelectorAll('[data-track-kind]')).map((track) => {
          const rect = track.getBoundingClientRect()
          const clip = track.querySelector('[class*="-clip"]')
          const clipRect = clip?.getBoundingClientRect()
          return {
            kind: track.dataset.trackKind,
            width: rect.width,
            clipWidth: clipRect?.width ?? 0,
            clipLeft: clipRect?.left ?? 0,
            left: rect.left,
            top: rect.top,
            bottom: rect.bottom,
          }
        })
        return {
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
          viewportWidth: viewport.width,
          tracks,
        }
      })
      const visibleTrackLabels = await page.locator('.timeline-track-label-list button').evaluateAll((nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom }
      }))
      const trackCounts = await page.locator('.timeline-scroll-viewport [data-track-kind]').evaluateAll((nodes) => nodes.reduce((counts, node) => {
        const kind = node.dataset.trackKind
        if (kind) counts[kind] = (counts[kind] ?? 0) + 1
        return counts
      }, {}))
      const minimumPreviewHeight = viewport.height >= 900 ? 400 : 240
      if (!previewBox || previewBox.height < minimumPreviewHeight) {
        throw new Error(`Merge preview is too short: ${previewBox ? `${Math.round(previewBox.width)}x${Math.round(previewBox.height)}` : 'missing'}`)
      }
      if (!playerBox || playerBox.height < 24) {
        throw new Error(`Merge playback controls are not visible: ${playerBox ? `${Math.round(playerBox.width)}x${Math.round(playerBox.height)}` : 'missing'}`)
      }
      if (!previewStageBox || !canvasBox) {
        throw new Error(`Merge preview stage or output canvas is missing: ${JSON.stringify({ previewStageBox, canvasBox })}`)
      }
      if (!headerBox || headerBox.height > 64) {
        throw new Error(`Merge shell header is not compact enough: ${JSON.stringify({ headerBox })}`)
      }
      if (mergeSubtitleCount !== 0) {
        throw new Error(`Merge page still renders a descriptive subtitle: ${mergeSubtitleCount}`)
      }
      if (previewResetCount !== 0 || topResetCount !== 1 || topAdvancedCount !== 1) {
        throw new Error(`Merge window controls are not in the top toolbar: ${JSON.stringify({ previewResetCount, topResetCount, topAdvancedCount })}`)
      }
      const outputRatio = 1920 / 1080
      const canvasRatio = canvasBox.width / Math.max(1, canvasBox.height)
      const canvasRight = canvasBox.x + canvasBox.width
      const canvasBottom = canvasBox.y + canvasBox.height
      const cellRight = previewStageBox.x + previewStageBox.width
      const cellBottom = previewStageBox.y + previewStageBox.height
      const horizontalCanvasGap = Math.max(canvasBox.x - previewStageBox.x, cellRight - canvasRight)
      const verticalCanvasGap = Math.max(canvasBox.y - previewStageBox.y, cellBottom - canvasBottom)
      if (horizontalCanvasGap > 8 || verticalCanvasGap > 8 || Math.abs(canvasRatio - outputRatio) > 0.02) {
        throw new Error(`Merge output canvas does not fill its preview cell or preserve aspect ratio: ${JSON.stringify({ previewBox, previewStageBox, canvasBox, canvasStyle, horizontalCanvasGap, verticalCanvasGap, canvasRatio, outputRatio })}`)
      }
      if (previewSliderCount !== 0) {
        throw new Error(`Merge preview still contains ${previewSliderCount} deprecated playback sliders`)
      }
      if (zoomControlCount !== 0) {
        throw new Error(`Merge timeline still contains ${zoomControlCount} manual zoom controls`)
      }
      const expectedTrackCounts = singleScenario
        ? { video: 1, audio: 0, text: 0 }
        : { video: 2, audio: 1, text: 1 }
      for (const kind of ['video', 'audio', 'text']) {
        if ((trackCounts[kind] ?? 0) !== expectedTrackCounts[kind]) {
          throw new Error(`Merge ${kind} track visibility mismatch: expected ${expectedTrackCounts[kind]}, got ${trackCounts[kind] ?? 0}`)
        }
      }
      const expectedOverlapToolbarCount = singleScenario ? 0 : 1
      if (overlapToolbarCount !== expectedOverlapToolbarCount) {
        throw new Error(`Merge overlap toolbar visibility mismatch: expected ${expectedOverlapToolbarCount}, got ${overlapToolbarCount}`)
      }
      if (timelineMetrics.scrollWidth > timelineMetrics.clientWidth + 1) {
        throw new Error(`Merge timeline unexpectedly overflows horizontally: ${JSON.stringify(timelineMetrics)}`)
      }
      if (mergePageOverflow.scrollWidth > mergePageOverflow.clientWidth + 1 || mergePageOverflow.scrollHeight > mergePageOverflow.clientHeight + 1) {
        throw new Error(`Merge page unexpectedly scrolls: ${JSON.stringify(mergePageOverflow)}`)
      }
      for (const kind of singleScenario ? ['video'] : ['video', 'audio', 'text']) {
        const track = timelineMetrics.tracks.find((item) => item.kind === kind)
        const expectedMinimumRatio = kind === 'text' ? 0.55 : 0.8
        if (!track || track.clipWidth < track.width * expectedMinimumRatio || Math.abs(track.clipLeft - track.left) > 2) {
          throw new Error(`Merge ${kind} track is not fit-to-width: ${JSON.stringify(track)}`)
        }
      }
      const expectedLabelCount = singleScenario ? 1 : 4
      const timelineBottom = timelineBox ? timelineBox.y + timelineBox.height : Number.NEGATIVE_INFINITY
      if (!timelineBox || visibleTrackLabels.length !== expectedLabelCount || visibleTrackLabels.some((rect) => rect.bottom > timelineBottom + 1)) {
        throw new Error(`Merge timeline tracks are not simultaneously visible: ${JSON.stringify({ timelineBox, visibleTrackLabels })}`)
      }
      const trackBottom = Math.max(...timelineMetrics.tracks.map((track) => track.bottom))
      const timelineBottomGap = timelineBox ? timelineBottom - trackBottom : Number.POSITIVE_INFINITY
      if (timelineBottomGap > 18) {
        throw new Error(`Merge timeline reserves too much empty space below visible tracks: ${JSON.stringify({ timelineBox, trackBottom, timelineBottomGap })}`)
      }
      if (singleScenario && timelineBox && timelineBox.height > 120) {
        throw new Error(`Single-track timeline is still too tall: ${Math.round(timelineBox.height)}px`)
      }
      if (!singleScenario && timelineBox && timelineBox.height > 210) {
        throw new Error(`Multi-track timeline is still using a fixed oversized height: ${Math.round(timelineBox.height)}px`)
      }
      const inspectorToggle = page.getByRole('button', { name: '属性' })
      await inspectorToggle.click()
      await page.locator('.editor-inspector-drawer.is-open').waitFor({ state: 'visible', timeout: 1000 })
      await page.locator('.editor-inspector-drawer-head button').click()
      if (await page.locator('.editor-inspector-drawer.is-open').count()) {
        throw new Error('Merge inspector drawer did not close after clicking its close button')
      }
      console.log(`[merge-layout] header=${Math.round(headerBox.width)}x${Math.round(headerBox.height)} preview=${Math.round(previewBox.width)}x${Math.round(previewBox.height)} player=${Math.round(playerBox.width)}x${Math.round(playerBox.height)} timeline=${Math.round(timelineBox.width)}x${Math.round(timelineBox.height)}`)
      mergeLayoutMetrics = {
        headerHeight: headerBox.height,
        previewHeight: previewBox.height,
        timelineHeight: timelineBox.height,
        timelineBottomGap,
        trackCount: trackCounts,
        canvasGap: Math.max(horizontalCanvasGap, verticalCanvasGap),
        canvasRatio,
      }
      if (await page.locator('.editor-export-status .merge-message.error').count()) {
        throw new Error(`Merge page displayed an application error: ${await page.locator('.editor-export-status .merge-message.error').first().innerText()}`)
      }
    }

    const screenshot = await page.screenshot({ fullPage: false })
    fs.writeFileSync(actualPath, screenshot)

    const actual = PNG.sync.read(screenshot)
    const blackStats = getBlackStats(actual)

    if (!baselinePath) {
      const routeErrors = pageErrors.slice(beforeErrorCount)
      result = {
        ...baseResult(route, url, actualPath, diffPath, baselinePath),
        ok: !blackStats.isMostlyBlack && routeErrors.length === 0,
        smokeOnly: true,
        blackStats,
        pageErrors: routeErrors,
        consoleMessages: consoleMessages.slice(beforeConsoleCount),
      }
    } else if (!fs.existsSync(baselinePath)) {
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
  if (mergeLayoutMetrics) mergeMetricsByRoute.set(route.id, mergeLayoutMetrics)
  writeProgress(result)
}

const singleMergeMetrics = mergeMetricsByRoute.get('page5_merge_single_page')
const overlapMergeMetrics = mergeMetricsByRoute.get('page5_merge_page')
if (singleMergeMetrics && overlapMergeMetrics && singleMergeMetrics.previewHeight <= overlapMergeMetrics.previewHeight) {
  const singleResult = results.find((item) => item.id === 'page5_merge_single_page')
  if (singleResult) {
    singleResult.ok = false
    singleResult.reason = `Single-track preview should be taller than the overlapping multi-track preview: ${Math.round(singleMergeMetrics.previewHeight)}px <= ${Math.round(overlapMergeMetrics.previewHeight)}px`
  }
}

await browser.close()
await managedDevServer?.close()

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
    else if (arg === '--navigation-timeout') parsed.navigationTimeout = args[++index]
    else if (arg === '--route') parsed.route = args[++index]
    else if (arg === '--language') parsed.language = args[++index]
  }
  return parsed
}

async function startManagedDevServerIfNeeded(url, parsedOptions) {
  if (await urlResponds(url)) return null
  const parsedUrl = new URL(url)
  const localHost = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost'
  if (parsedOptions.url || !localHost || parsedOptions.realTauri === true) {
    throw new Error(`Visual QA target is not reachable: ${url}`)
  }

  const { build, preview } = await import('vite')
  await build({ root: desktopDir })
  const server = await preview({
    root: desktopDir,
    preview: {
      host: parsedUrl.hostname,
      port: Number(parsedUrl.port || 5173),
      strictPort: true,
    },
  })
  return {
    close: () => new Promise((resolve, reject) => {
      server.httpServer.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function urlResponds(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
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

async function installTauriMock(page, language) {
  if (language) {
    await page.addInitScript((appLanguage) => {
      window.localStorage.setItem('video-similarity-settings', JSON.stringify({
        state: { appLanguage },
        version: 0,
      }))
    }, language)
  }
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
        jsonPath: 'D:\\Reports\\report_2026_05_24.json',
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
        formats: ['json', 'csv', 'html'],
      },
      {
        id: 'hp_compare',
        path: 'D:\\Reports\\HP 对比报告.json',
        jsonPath: 'D:\\Reports\\HP 对比报告.json',
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
        formats: ['json', 'csv', 'html'],
      },
      {
        id: 'batch_01',
        path: 'D:\\Reports\\批量检测结果_01.json',
        jsonPath: 'D:\\Reports\\批量检测结果_01.json',
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
        formats: ['json', 'csv', 'html'],
      },
      {
        id: 'weekly',
        path: 'D:\\Reports\\相似度分析_周报.json',
        jsonPath: 'D:\\Reports\\相似度分析_周报.json',
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
        formats: ['json', 'csv', 'html'],
      },
      {
        id: 'abnormal',
        path: 'D:\\Reports\\异常对比_20260520.json',
        jsonPath: 'D:\\Reports\\异常对比_20260520.json',
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
        formats: ['json'],
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
            version: '1.1.0',
            buildFlavor: 'cpu',
            installType: 'portable',
            installRoot: 'D:\\Agent\\Project\\video-containment-detector',
          }
        }
        if (cmd === 'get_runtime_status') {
          return {
            ready: true,
            managed: true,
            legacyFallback: false,
            legacyMigrationAvailable: false,
            legacyCleanupAvailable: false,
            legacyRuntimeDir: '',
            expectedVersion: '1',
            installedVersion: '1',
            flavor: 'cpu',
            runtimeDir: 'D:\\Video Similarity\\env',
            pythonPath: 'D:\\Video Similarity\\env\\python\\python.exe',
            assetName: 'Video_Similarity-runtime-v1-windows-x64-cpu.zip',
            message: 'Managed runtime is ready.',
          }
        }
        if (cmd === 'scan_videos') return videos
        if (cmd === 'probe_video_metadata') return []
        if (cmd === 'list_reports') return reports
        if (cmd === 'read_report') return sampleReport
        if (cmd === 'read_text_file') return JSON.stringify(sampleReport)
        if (cmd === 'path_status') {
          return {
            exists: true,
            isFile: true,
            normalizedPath: 'D:\\Reports\\report_2026_05_24.json',
          }
        }
        if (cmd === 'list_analysis_tasks' || cmd === 'list_config_templates') return []
        if (cmd === 'get_file_move_status') {
          return {
            running: false,
            cancelRequested: false,
            completed: 0,
            total: 0,
            currentPath: '',
            targetDir: '',
            pendingPaths: [],
          }
        }
        if (cmd === 'get_clip_model_status') {
          return {
            installed: true,
            modelDir: 'D:\\Video Similarity\\models\\clip-vit-base-patch32',
            sizeBytes: 605_000_000,
            message: 'Offline CLIP model is ready.',
            requiredFiles: ['config.json', 'preprocessor_config.json', 'pytorch_model.bin'],
            missingFiles: [],
          }
        }
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
