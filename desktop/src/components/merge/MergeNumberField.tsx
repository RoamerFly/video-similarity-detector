import { useState } from 'react'
import { ParameterHint, TextInput } from '@/components/DesignSystem'

interface MergeNumberFieldProps {
  label: string
  tip?: string
  value: number
  min?: number
  max?: number
  step?: number
  placeholder?: string
  onChange: (value: number) => void
}

export function MergeNumberField({
  label,
  tip,
  value,
  min,
  max,
  step = 1,
  placeholder,
  onChange,
}: MergeNumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (raw: string) => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      return
    }
    const next = clamp(parsed, min, max)
    onChange(next)
  }

  return (
    <label>
      {tip ? <ParameterHint label={label} tip={tip} /> : <span>{label}</span>}
      <TextInput
        type="number"
        value={draft ?? formatValue(value)}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onFocus={() => setDraft(formatValue(value))}
        onChange={(event) => {
          const raw = event.target.value
          setDraft(raw)
          // Keep the field visually empty while the user is replacing the
          // value; do not clamp an empty string back to the minimum.
          if (raw.trim() !== '') {
            const parsed = Number(raw)
            if (Number.isFinite(parsed)) onChange(clamp(parsed, min, max))
          }
        }}
        onBlur={() => {
          const raw = draft ?? formatValue(value)
          setDraft(null)
          if (raw.trim() !== '') commit(raw)
        }}
      />
    </label>
  )
}

function formatValue(value: number | undefined) {
  return Number.isFinite(value) ? String(value) : ''
}

function clamp(value: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  return Math.max(min, Math.min(max, value))
}
