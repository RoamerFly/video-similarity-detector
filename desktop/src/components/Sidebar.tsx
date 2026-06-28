import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { BarChart3, Clapperboard, Grid2X2, Images, Settings } from 'lucide-react'
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

export function Sidebar() {
  const { t } = useI18n()
  const [version, setVersion] = useState('')

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

      <div className="version-pill">{version ? `v${version}` : 'v...'}</div>
    </aside>
  )
}
