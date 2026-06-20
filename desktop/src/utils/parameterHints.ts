export const parameterHints = {
  videoDir: '要分析的视频文件夹，程序会递归扫描常见视频格式。',
  outputDir: '分析完成后，JSON、CSV 和 HTML 报告会保存到这里。',
  pythonPath: '运行分析脚本使用的 Python，可选择打包自带的 env 环境。',
  projectRoot: '脚本、模型和 data 目录的基准位置，打包版通常是 exe 同级目录。',
  cacheDir: '保存抽帧结果和特征缓存，重复分析同一视频会更快。',
  clearCache: '删除旧的抽帧、特征和断点缓存；报告文件会保留。',
  reportDir: '保存分析报告的位置，结果页会优先从这里读取。',
  skipThreshold: '画面越相似越容易跳过；调低会更快，调高会保留更多细节。',
  matchThreshold: '两帧被认为相似的最低分数，越高越严格。',
  windowSize: '按多少秒切一段，用来统计局部时间窗口相似度。',
  topK: '每一帧最多保留多少个候选相似帧。',
  candidateLimit: '每个视频最多精确比较多少个粗筛候选；0 表示比较全部视频对。',
  maxGapSec: '即使画面变化不大，也会按这个间隔保留一帧。',
  frameStep: '长视频加速项；每隔多少帧检查一次，1 表示逐帧检查。',
  minSegmentDuration: '匹配片段至少持续多久才显示；调低可找短片段。',
  minSegmentMatches: '一个片段至少需要几个相似帧；调低更敏感，调高更稳。',
  offsetTolerance: '同一片段内两段视频的时间差允许波动多少秒。',
  cropBlackBorders: '先去掉四周黑边，减少电影黑边对相似度的影响。',
  force: '忽略旧缓存，重新抽帧并计算特征；通常只在参数变更后开启。',
  resizeMode: '把不同尺寸的视频统一到相同分辨率的方式。',
  inputSize: '参与匹配前统一缩放或裁剪到的像素尺寸。',
  portraitRotation: '竖屏视频裁剪后按这个方向转成横屏再比较。',
  device: '自动选择 CPU 或 CUDA，也可以手动指定。',
  checkEnvOnStartup: '打开设置页时自动检查 Python、脚本、报告目录和 GPU 状态。',
  openMaximized: '启动应用后自动最大化窗口，减少页面拥挤和滚动。',
  closeBehavior: '设置点击关闭按钮时是每次询问、进入托盘，还是直接退出。',
} as const

export function withEnglish(cn: string, en: string) {
  return `${cn}(${en})`
}
