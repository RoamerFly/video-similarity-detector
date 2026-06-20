import { NavLink } from 'react-router-dom'
import { BarChart3, Clapperboard, Grid2X2, Images, Settings } from 'lucide-react'
import { cn } from '@/utils/cn'

const navItems = [
  { path: '/', label: '分析任务', icon: BarChart3 },
  { path: '/results', label: '结果总览', icon: Grid2X2 },
  { path: '/compare', label: '对比视图', icon: Images },
  { path: '/merge', label: '合并视频', icon: Clapperboard },
  { path: '/settings', label: '设置', icon: Settings },
]

export function Sidebar() {
  return (
    <aside className="app-sidebar">
      <nav className="sidebar-nav" aria-label="主导航">
        {navItems.map((item) => {
          const Icon = item.icon

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              title={item.label}
              className={({ isActive }) => cn('sidebar-link', isActive && 'active')}
            >
              <Icon />
              <span>{item.label}</span>
            </NavLink>
          )
        })}
      </nav>

      <div className="version-pill">v1.0.0</div>
    </aside>
  )
}
