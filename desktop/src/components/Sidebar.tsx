import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { BarChart3, Clapperboard, Grid2X2, Images, Settings } from 'lucide-react'
import { AnalysisExportStatus } from '@/components/analysis/AnalysisExportStatus'
import { MergeExportStatus } from '@/components/merge/MergeExportStatus'
import { useI18n } from '@/i18n/useI18n'
import { getAppInfo } from '@/services/backend'
import { cn } from '@/utils/cn'

const navItems = [
  { path: '/', label: '分析任务', icon: BarChart3 },
  { path: '/results', label: '结果总览', icon: Grid2X2 },
  { path: '/compare', label: '对比视图', icon: Images },
  { path: '/merge', label: '合并视频', icon: Clapperboard },
  { path: '/settings', label: '设置', icon: Settings },
]

// Keep this order in one place so the footer remains predictable on every route.
// Both task status components are mounted by Sidebar and continue to reflect
// their stores while the user visits results, comparison, or settings pages.
// eslint-disable-next-line react-refresh/only-export-components -- layout contract is covered by Sidebar.test.ts.
export const sidebarStatusCapsuleOrder = ['analysis', 'merge', 'version'] as const

type ExpandedSidebarCapsule = Exclude<(typeof sidebarStatusCapsuleOrder)[number], 'version'>

// Keep the transition in one place so changing capsules always closes the
// previously expanded one, including when both controls are mounted together.
// eslint-disable-next-line react-refresh/only-export-components -- pure state transition is covered by Sidebar.test.ts.
export function toggleSidebarStatusCapsule(
  current: ExpandedSidebarCapsule | null,
  target: ExpandedSidebarCapsule,
): ExpandedSidebarCapsule | null {
  return current === target ? null : target
}

export function Sidebar() {
  const { t } = useI18n()
  const [version, setVersion] = useState('')
  const [expandedCapsule, setExpandedCapsule] = useState<ExpandedSidebarCapsule | null>(null)

  useEffect(() => {
    let active = true
    getAppInfo()
      .then((info) => {
        if (active) setVersion(info.version)
      })
      .catch(() => {
        if (active) setVersion('')
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <aside className="app-sidebar">
      <nav className="sidebar-nav" aria-label={t('主导航')}>
        {navItems.map((item) => {
          const Icon = item.icon
          const label = t(item.label)

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              title={label}
              className={({ isActive }) => cn('sidebar-link', isActive && 'active')}
            >
              <Icon />
              <span>{label}</span>
            </NavLink>
          )
        })}
      </nav>

      <div className="sidebar-version-row">
        {sidebarStatusCapsuleOrder.map((capsule) => {
          if (capsule === 'analysis') {
            return (
              <div className="merge-export-status-anchor analysis-export-status-anchor" key={capsule}>
                <AnalysisExportStatus
                  expanded={expandedCapsule === capsule}
                  onExpandedChange={(nextExpanded) => {
                    setExpandedCapsule((current) => nextExpanded
                      ? toggleSidebarStatusCapsule(current, capsule)
                      : current === capsule ? null : current)
                  }}
                />
              </div>
            )
          }

          if (capsule === 'merge') {
            return (
              <div className="merge-export-status-anchor merge-export-status-anchor-video" key={capsule}>
                <MergeExportStatus
                  expanded={expandedCapsule === capsule}
                  onExpandedChange={(nextExpanded) => {
                    setExpandedCapsule((current) => nextExpanded
                      ? toggleSidebarStatusCapsule(current, capsule)
                      : current === capsule ? null : current)
                  }}
                />
              </div>
            )
          }

          return (
            <div className="version-pill" key={capsule}>{version ? `v${version}` : 'v...'}</div>
          )
        })}
      </div>
    </aside>
  )
}
