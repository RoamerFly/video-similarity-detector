export function extension(path: string) {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

export function clamp(
  value: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
) {
  return Math.max(min, Math.min(max, value))
}

export function normalizePath(path: string) {
  return path.replaceAll('\\', '/').toLowerCase()
}

export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return [hours, minutes, secs].map((value) => String(value).padStart(2, '0')).join(':')
}

export function formatPreciseTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const whole = Math.floor(safe)
  const milliseconds = Math.floor((safe - whole) * 1000)
  return `${formatDuration(whole)}.${String(milliseconds).padStart(3, '0')}`
}

export function formatEstimatedSize(bytes: number) {
  const safe = Math.max(0, Number.isFinite(bytes) ? bytes : 0)
  if (safe >= 1_000_000_000) return `${(safe / 1_000_000_000).toFixed(2)} GB`
  return `${Math.round(safe / 1_000_000)} MB`
}

export function formatTick(seconds: number) {
  return seconds >= 3600 ? formatDuration(seconds) : formatDuration(seconds).slice(3)
}
