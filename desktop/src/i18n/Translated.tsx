import type { ReactNode } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { translateNode } from '@/i18n/useI18n'

export function Translated({ children }: { children: ReactNode }) {
  const language = useSettingsStore((state) => state.appLanguage)
  return <>{translateNode(children, language)}</>
}
