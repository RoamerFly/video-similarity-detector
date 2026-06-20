import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from '@/utils/cn'

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean
}

export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(
  ({ className, hover = false, children, ...props }, ref) => {
    const baseClasses = cn(
      'rounded-2xl',
      'bg-[rgba(8,16,45,0.72)]',
      'border border-[rgba(120,150,255,0.22)]',
      'backdrop-blur-xl',
      hover && 'transition-all duration-300 hover:bg-[rgba(8,16,45,0.85)] hover:border-[rgba(120,150,255,0.35)]',
      className
    )

    return (
      <div ref={ref} className={baseClasses} {...props}>
        {children}
      </div>
    )
  }
)

GlassCard.displayName = 'GlassCard'
