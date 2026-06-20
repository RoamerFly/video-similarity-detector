import { useEffect, useState } from 'react'
import { Minus, Square, SquareStack, X } from 'lucide-react'
import {
  isWindowMaximized,
  minimizeWindow,
  toggleMaximizeWindow,
} from '@/services/backend'

interface WindowControlsProps {
  onRequestClose: () => void
}

export function WindowControls({ onRequestClose }: WindowControlsProps) {
  const [maximized, setMaximized] = useState(false)

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
    <div className="window-controls" aria-label="窗口控制">
      <button
        className="window-control"
        type="button"
        title="最小化"
        aria-label="最小化"
        onClick={() => void minimizeWindow().catch(() => undefined)}
      >
        <Minus size={15} strokeWidth={2.2} />
      </button>
      <button
        className="window-control"
        type="button"
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
        onClick={() => void handleToggleMaximize()}
      >
        {maximized ? <SquareStack size={15} strokeWidth={2.1} /> : <Square size={14} strokeWidth={2.1} />}
      </button>
      <button
        className="window-control window-control-close"
        type="button"
        title="关闭"
        aria-label="关闭"
        onClick={onRequestClose}
      >
        <X size={16} strokeWidth={2.2} />
      </button>
    </div>
  )
}
