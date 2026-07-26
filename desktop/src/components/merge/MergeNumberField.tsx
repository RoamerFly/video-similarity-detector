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
  return (
    <label>
      {tip ? <ParameterHint label={label} tip={tip} /> : <span>{label}</span>}
      <TextInput
        type="number"
        value={value || ''}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(event) => onChange(clamp(numeric(event.target.value), min, max))}
      />
    </label>
  )
}

function numeric(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function clamp(value: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  return Math.max(min, Math.min(max, value))
}
