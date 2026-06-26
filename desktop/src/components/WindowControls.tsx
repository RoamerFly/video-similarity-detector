import { useEffect, useState } from 'react'
import { Minus, Square, SquareStack, X } from 'lucide-react'
import {
  isWindowMaximized,
  minimizeWindow,
  toggleMaximizeWindow,
} from '@/services/backend'
import { useI18n } from '@/i18n/useI18n'

interface WindowControlsProps {
  onRequestClose: () => void
}

export function WindowControls({ onRequestClose }: WindowControlsProps) {
  const [maximized, setMaximized] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    let alive = true
    void isWindowMaximized()
      .then((value) => {
        if (alive) setMaximized(value)
      })
      .catch(() => undefined)

    return () => {
      alive = false
    }
  }, [])

  async function handleToggleMaximize() {
    try {
      const value = await toggleMaximizeWindow()
      setMaximized(value)
    } catch {
      // Window controls are only available in the Tauri runtime.
    }
  }

  return (
    <div className="window-controls" aria-label={t('窗口控制')}>
      <button
        className="window-control"
        type="button"
        title={t('最小化')}
        aria-label={t('最小化')}
        onClick={() => void minimizeWindow().catch(() => undefined)}
      >
        <Minus size={15} strokeWidth={2.2} />
      </button>
      <button
        className="window-control"
        type="button"
        title={t(maximized ? '还原' : '最大化')}
        aria-label={t(maximized ? '还原' : '最大化')}
        onClick={() => void handleToggleMaximize()}
      >
        {maximized ? <SquareStack size={15} strokeWidth={2.1} /> : <Square size={14} strokeWidth={2.1} />}
      </button>
      <button
        className="window-control window-control-close"
        type="button"
        title={t('关闭')}
        aria-label={t('关闭')}
        onClick={onRequestClose}
      >
        <X size={16} strokeWidth={2.2} />
      </button>
    </div>
  )
}
