import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react'
import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'
import type { Tone } from '@/types/ui'
import { cn } from '@/utils/cn'

const toneClass: Record<Tone, string> = {
  blue: 'tone-blue',
  purple: 'tone-purple',
  pink: 'tone-pink',
  cyan: 'tone-cyan',
  orange: 'tone-orange',
  green: 'tone-green',
  red: 'tone-red',
}

interface GlassPanelProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode
  active?: boolean
}

export function GlassPanel({ children, className, active = false, ...props }: GlassPanelProps) {
  return (
    <section className={cn('glass-panel', active && 'is-active', className)} {...props}>
      {children}
    </section>
  )
}

interface NeonButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'outline' | 'ghost'
  tone?: Tone
}

export function NeonButton({
  children,
  className,
  variant = 'primary',
  tone = 'purple',
  ...props
}: NeonButtonProps) {
  const { tn } = useI18n()
  return (
    <button className={cn('neon-button', `neon-button-${variant}`, toneClass[tone], className)} {...props}>
      {tn(children)}
    </button>
  )
}

interface StatCardProps {
  title: string
  value: string | number
  unit?: string
  icon: ReactNode
  tone?: Tone
  className?: string
}

export function StatCard({ title, value, unit, icon, tone = 'blue', className }: StatCardProps) {
  const { t } = useI18n()
  const localizedTitle = t(title)
  return (
    <div className={cn('stat-card', toneClass[tone], className)}>
      <div className="stat-icon">{icon}</div>
      <div>
        <p className="stat-title" title={localizedTitle}>{localizedTitle}</p>
        <div className="stat-value-row">
          <span className="stat-value" title={String(value)}>{value}</span>
          {unit && <span className="stat-unit">{t(unit)}</span>}
        </div>
      </div>
    </div>
  )
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const { t } = useI18n()
  const title = props.title ?? (typeof props.value === 'string' ? props.value : undefined)
  return (
    <input
      className={cn('design-input', className)}
      {...props}
      placeholder={typeof props.placeholder === 'string' ? t(props.placeholder) : props.placeholder}
      title={typeof title === 'string' ? t(title) : title}
      aria-label={typeof props['aria-label'] === 'string' ? t(props['aria-label']) : props['aria-label']}
    />
  )
}

export function SelectInput({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const { t, tn } = useI18n()
  return (
    <select
      className={cn('design-select', className)}
      {...props}
      title={typeof props.title === 'string' ? t(props.title) : props.title}
      aria-label={typeof props['aria-label'] === 'string' ? t(props['aria-label']) : props['aria-label']}
    >
      {tn(children)}
    </select>
  )
}

interface ToggleProps {
  checked: boolean
  onChange?: (checked: boolean) => void
}

export function Toggle({ checked, onChange }: ToggleProps) {
  return (
    <button
      className={cn('toggle-switch', checked && 'is-on')}
      type="button"
      onClick={() => onChange?.(!checked)}
      aria-pressed={checked}
    >
      <span />
    </button>
  )
}

interface SliderProps {
  label?: string
  value: number
  min?: number
  max?: number
  step?: number
  tone?: Tone
  onChange?: (value: number) => void
}

export function Slider({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  tone = 'purple',
  onChange,
}: SliderProps) {
  const { t } = useI18n()
  const percentage = ((value - min) / (max - min)) * 100

  return (
    <label className={cn('slider-control', toneClass[tone])}>
      {label && <span>{t(label)}</span>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange?.(Number(event.target.value))}
        style={{ '--slider-progress': `${percentage}%` } as CSSProperties}
      />
    </label>
  )
}

interface BadgeProps {
  children: ReactNode
  tone?: Tone
  className?: string
}

export function Badge({ children, tone = 'blue', className }: BadgeProps) {
  const { tn } = useI18n()
  return <span className={cn('design-badge', toneClass[tone], className)}>{tn(children)}</span>
}

interface MetricBarProps {
  value: number
  tone?: Tone
}

export function MetricBar({ value, tone = 'purple' }: MetricBarProps) {
  return (
    <span className={cn('metric-bar', toneClass[tone])}>
      <span style={{ width: `${value}%` }} />
    </span>
  )
}

interface ParameterHintProps {
  label: ReactNode
  tip: string
  className?: string
}

export function ParameterHint({ label, tip, className }: ParameterHintProps) {
  const { t, tn } = useI18n()
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null)

  const showTooltip = useCallback((element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    const placement = rect.top > 120 ? 'top' : 'bottom'
    setTooltipPosition({
      left: Math.min(Math.max(rect.left + rect.width / 2, 160), window.innerWidth - 160),
      top: placement === 'top' ? rect.top - 10 : rect.bottom + 10,
      placement,
    })
  }, [])

  return (
    <span className={cn('parameter-hint', className)} title={t(tip)}>
      <span>{tn(label)}</span>
      <span
        className="parameter-hint-icon"
        aria-label={t(tip)}
        tabIndex={0}
        onMouseEnter={(event) => showTooltip(event.currentTarget)}
        onMouseLeave={() => setTooltipPosition(null)}
        onFocus={(event) => showTooltip(event.currentTarget)}
        onBlur={() => setTooltipPosition(null)}
      >
        <Info size={14} />
      </span>
      {tooltipPosition && createPortal(
        <span
          className={cn('parameter-tooltip-portal', `is-${tooltipPosition.placement}`)}
          style={{
            left: tooltipPosition.left,
            top: tooltipPosition.top,
          }}
        >
          {t(tip)}
        </span>,
        document.body,
      )}
    </span>
  )
}
