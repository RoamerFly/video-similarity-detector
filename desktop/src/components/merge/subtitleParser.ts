export interface SubtitleCue {
  start: number
  end: number
  text: string
}

export function parseSubtitleCues(content: string, fileExtension: string): SubtitleCue[] {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const ext = fileExtension.toLowerCase()
  if (ext === 'ass' || ext === 'ssa') return parseAssSubtitleCues(normalized)
  return parseTimedTextSubtitleCues(normalized)
}

function parseTimedTextSubtitleCues(content: string): SubtitleCue[] {
  return content
    .replace(/^WEBVTT[^\n]*(?:\n|$)/i, '')
    .split(/\n{2,}/)
    .flatMap((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
      const timingIndex = lines.findIndex((line) => line.includes('-->'))
      if (timingIndex < 0) return []
      const [rawStart, rawEnd] = lines[timingIndex].split('-->').map((part) => part.trim())
      const start = parseSubtitleTime(rawStart)
      const end = parseSubtitleTime(rawEnd.split(/\s+/)[0] ?? '')
      const text = cleanSubtitleText(lines.slice(timingIndex + 1).join('\n'))
      if (start === null || end === null || end <= start || !text) return []
      return [{ start, end, text }]
    })
}

function parseAssSubtitleCues(content: string): SubtitleCue[] {
  let format = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
  const cues: SubtitleCue[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (/^Format:/i.test(line)) {
      format = line.replace(/^Format:/i, '').split(',').map((part) => part.trim().toLowerCase())
      continue
    }
    if (!/^Dialogue:/i.test(line)) continue
    const fields = splitAssDialogueFields(line.replace(/^Dialogue:/i, '').trim(), format.length)
    const startIndex = format.indexOf('start')
    const endIndex = format.indexOf('end')
    const textIndex = format.indexOf('text')
    const start = parseSubtitleTime(fields[startIndex] ?? '')
    const end = parseSubtitleTime(fields[endIndex] ?? '')
    const text = cleanSubtitleText((textIndex >= 0 ? fields.slice(textIndex).join(',') : fields.at(-1) ?? '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\{[^}]*}/g, ''))
    if (start === null || end === null || end <= start || !text) continue
    cues.push({ start, end, text })
  }
  return cues
}

function splitAssDialogueFields(value: string, fieldCount: number) {
  if (fieldCount <= 1) return [value]
  const fields = value.split(',')
  if (fields.length <= fieldCount) return fields.map((field) => field.trim())
  return [
    ...fields.slice(0, fieldCount - 1).map((field) => field.trim()),
    fields.slice(fieldCount - 1).join(',').trim(),
  ]
}

function parseSubtitleTime(value: string) {
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/)
  if (!match) return null
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2] ?? 0)
  const seconds = Number(match[3] ?? 0)
  const fraction = match[4] ?? ''
  const milliseconds = fraction ? Number(fraction.padEnd(3, '0').slice(0, 3)) : 0
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000
}

function cleanSubtitleText(value: string) {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}
