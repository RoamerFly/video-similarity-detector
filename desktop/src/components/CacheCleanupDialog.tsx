import { createPortal } from 'react-dom'
import { CheckCircle2, Trash2, X } from 'lucide-react'
import { NeonButton } from '@/components/DesignSystem'
import { formatBytes, type CacheScanResult } from '@/services/backend'

export function CacheCleanupDialog({
  open,
  scan,
  selectedPaths,
  busy,
  title = '缓存清理',
  ariaLabel = '缓存清理',
  emptyMessage = '没有发现可清理的缓存项目。',
  confirmLabel = '清理选中',
  onTogglePath,
  onSelectAll,
  onClearSelection,
  onClose,
  onConfirm,
}: {
  open: boolean
  scan: CacheScanResult | null
  selectedPaths: Set<string>
  busy: boolean
  title?: string
  ariaLabel?: string
  emptyMessage?: string
  confirmLabel?: string
  onTogglePath: (path: string, checked: boolean) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onClose: () => void
  onConfirm: (paths: string[]) => void
}) {
  if (!open) return null

  const items = scan?.items ?? []
  const selectedItems = items.filter((item) => selectedPaths.has(item.path))
  const selectedSize = selectedItems.reduce((sum, item) => sum + item.sizeBytes, 0)

  return createPortal(
    <div className="modal-backdrop cache-cleanup-backdrop" role="presentation">
      <section className="cache-cleanup-dialog" role="dialog" aria-modal="true" aria-label={ariaLabel}>
        <div className="cache-cleanup-head">
          <div>
            <h3>{title}</h3>
            <p title={scan?.cacheDir || ''}>{scan?.message || '正在检查缓存目录...'}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={`关闭${ariaLabel}`} disabled={busy}>
            <X size={18} />
          </button>
        </div>

        <div className="cache-cleanup-summary">
          <span title={scan?.cacheDir || '-'}>目录：{scan?.cacheDir || '-'}</span>
          <strong>总大小：{formatBytes(scan?.totalSizeBytes ?? 0)}</strong>
          <strong>已选：{selectedItems.length} 项 / {formatBytes(selectedSize)}</strong>
        </div>

        <div className="cache-cleanup-toolbar">
          <button type="button" onClick={onSelectAll} disabled={busy || items.length === 0}>全选</button>
          <button type="button" onClick={onClearSelection} disabled={busy || selectedItems.length === 0}>取消选择</button>
        </div>

        <div className="cache-cleanup-list">
          {items.length > 0 ? items.map((item) => (
            <label className="cache-cleanup-item" key={item.id} title={item.path}>
              <input
                type="checkbox"
                checked={selectedPaths.has(item.path)}
                onChange={(event) => onTogglePath(item.path, event.target.checked)}
                disabled={busy}
              />
              <div>
                <strong>{item.category}</strong>
                <span>{item.name}</span>
                <small title={item.description}>{item.description}</small>
                <em title={item.path}>{item.path}</em>
              </div>
              <b>{formatBytes(item.sizeBytes)}</b>
              <i>{item.entryCount} 项</i>
            </label>
          )) : (
            <div className="cache-cleanup-empty">
              <CheckCircle2 size={22} />
              <span>{emptyMessage}</span>
            </div>
          )}
        </div>

        <div className="cache-cleanup-actions">
          <NeonButton variant="outline" type="button" onClick={onClose} disabled={busy}>
            取消
          </NeonButton>
          <NeonButton
            tone="red"
            type="button"
            disabled={busy || selectedItems.length === 0}
            onClick={() => onConfirm(Array.from(selectedPaths))}
          >
            <Trash2 size={18} />
            {busy ? '清理中' : `${confirmLabel}(${selectedItems.length})`}
          </NeonButton>
        </div>
      </section>
    </div>,
    document.body,
  )
}
