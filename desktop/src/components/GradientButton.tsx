import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/utils/cn'

interface GradientButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
}

export const GradientButton = forwardRef<HTMLButtonElement, GradientButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading = false, disabled, children, ...props }, ref) => {
    const baseClasses = cn(
      'relative inline-flex items-center justify-center',
      'font-medium rounded-2xl',
      'transition-all duration-300',
      'focus:outline-none focus:ring-2 focus:ring-[#7C3AED] focus:ring-offset-2 focus:ring-offset-transparent',
      'disabled:opacity-50 disabled:cursor-not-allowed',
      // Sizes
      {
        'px-4 py-2 text-sm gap-2': size === 'sm',
        'px-6 py-3 text-base gap-2': size === 'md',
        'px-8 py-4 text-lg gap-3': size === 'lg',
      },
      // Variants
      {
        // Primary - gradient background
        'text-white shadow-lg': variant === 'primary',
        // Secondary - outlined
        'border border-[rgba(120,150,255,0.3)] text-white hover:border-[rgba(120,150,255,0.5)]': variant === 'secondary',
        // Ghost
        'text-white/70 hover:text-white hover:bg-white/10': variant === 'ghost',
      },
      className
    )

    const gradientBg = variant === 'primary' ? {
      background: 'linear-gradient(135deg, #2F7CFF 0%, #7C3AED 50%, #EC4ED8 100%)',
    } : {}

    return (
      <button
        ref={ref}
        className={baseClasses}
        style={gradientBg}
        disabled={disabled || loading}
        {...props}
      >
        {loading && (
          <svg
            className="animate-spin -ml-1 mr-2 h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {children}
      </button>
    )
  }
)

GradientButton.displayName = 'GradientButton'
