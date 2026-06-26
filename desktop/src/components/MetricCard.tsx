import { motion } from 'framer-motion'
import { useI18n } from '@/i18n/useI18n'
import { cn } from '@/utils/cn'
import { GlassCard } from './GlassCard'

interface MetricCardProps {
  title: string
  value: string | number
  subtitle?: string
  icon?: React.ReactNode
  trend?: 'up' | 'down' | 'neutral'
  trendValue?: string
  color?: 'blue' | 'purple' | 'pink' | 'green' | 'amber' | 'gray'
  className?: string
}

const colorMap = {
  blue: {
    icon: 'text-[#2F7CFF]',
    value: 'text-[#2F7CFF]',
    bg: 'rgba(47, 124, 255, 0.1)',
  },
  purple: {
    icon: 'text-[#7C3AED]',
    value: 'text-[#7C3AED]',
    bg: 'rgba(124, 58, 237, 0.1)',
  },
  pink: {
    icon: 'text-[#EC4ED8]',
    value: 'text-[#EC4ED8]',
    bg: 'rgba(236, 78, 216, 0.1)',
  },
  green: {
    icon: 'text-green-500',
    value: 'text-green-500',
    bg: 'rgba(34, 197, 94, 0.1)',
  },
  amber: {
    icon: 'text-amber-500',
    value: 'text-amber-500',
    bg: 'rgba(245, 158, 11, 0.1)',
  },
  gray: {
    icon: 'text-gray-400',
    value: 'text-gray-300',
    bg: 'rgba(107, 114, 128, 0.1)',
  },
}

export function MetricCard({
  title,
  value,
  subtitle,
  icon,
  trend,
  trendValue,
  color = 'blue',
  className,
}: MetricCardProps) {
  const colors = colorMap[color]
  const { t } = useI18n()

  return (
    <GlassCard className={cn('p-5', className)} hover>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm text-white/50 mb-1">{t(title)}</p>
          <motion.p
            className={cn('text-2xl font-bold', colors.value)}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3, delay: 0.1 }}
          >
            {value}
          </motion.p>
          {subtitle && (
            <p className="text-xs text-white/40 mt-1">{t(subtitle)}</p>
          )}
          {trend && trendValue && (
            <div className="flex items-center gap-1 mt-2">
              <span
                className={cn('text-xs', {
                  'text-green-500': trend === 'up',
                  'text-red-500': trend === 'down',
                  'text-gray-400': trend === 'neutral',
                })}
              >
                {trend === 'up' && '↑'}
                {trend === 'down' && '↓'}
                {trend === 'neutral' && '→'}
                {' '}{t(trendValue)}
              </span>
            </div>
          )}
        </div>
        {icon && (
          <div
            className={cn('p-3 rounded-xl', colors.icon)}
            style={{ backgroundColor: colors.bg }}
          >
            {icon}
          </div>
        )}
      </div>
    </GlassCard>
  )
}
