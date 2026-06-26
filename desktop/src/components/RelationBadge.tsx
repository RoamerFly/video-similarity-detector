import { motion } from 'framer-motion'
import { useI18n } from '@/i18n/useI18n'
import { cn } from '@/utils/cn'
import { type VideoRelation, getRelationInfo } from '@/utils/relation'

interface RelationBadgeProps {
  relation: VideoRelation
  size?: 'sm' | 'md' | 'lg'
  showDescription?: boolean
  className?: string
}

export function RelationBadge({
  relation,
  size = 'md',
  showDescription = false,
  className,
}: RelationBadgeProps) {
  const info = getRelationInfo(relation)
  const { t } = useI18n()

  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-3 py-1 text-sm',
    lg: 'px-4 py-1.5 text-base',
  }

  return (
    <motion.div
      className={cn('inline-flex flex-col items-start gap-1', className)}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
    >
      <span
        className={cn(
          'inline-flex items-center font-medium rounded-full',
          sizeClasses[size]
        )}
        style={{
          backgroundColor: info.bgColor,
          borderColor: info.borderColor,
          borderWidth: '1px',
          color: info.color,
        }}
      >
        <span
          className="w-2 h-2 rounded-full mr-2"
          style={{ backgroundColor: info.color }}
        />
        {t(info.label)}
      </span>
      {showDescription && (
        <p className="text-xs text-white/50 ml-1">{t(info.description)}</p>
      )}
    </motion.div>
  )
}
