import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { translateMultiline, translateText } from '@/i18n/messages'
import { useSettingsStore } from '@/stores/settingsStore'
import type { AppLanguage } from '@/types/config'

const translatableProps = [
  'title',
  'aria-label',
  'placeholder',
  'alt',
  'label',
  'tip',
  'subtitle',
  'emptyMessage',
  'confirmLabel',
  'ariaLabel',
  'unit',
] as const

export function useI18n() {
  const language = useSettingsStore((state) => state.appLanguage)
  return {
    language,
    t: (value: string) => translateText(value, language),
    tm: (value: string) => translateMultiline(value, language),
    tn: (node: ReactNode) => translateNode(node, language),
  }
}

export function Translated({ children }: { children: ReactNode }) {
  const language = useSettingsStore((state) => state.appLanguage)
  return <>{translateNode(children, language)}</>
}

export function translateNode(node: ReactNode, language: AppLanguage): ReactNode {
  if (typeof node === 'string') return translateText(node, language)
  if (typeof node === 'number' || node == null || typeof node === 'boolean') return node
  if (Array.isArray(node)) return node.map((item) => translateNode(item, language))
  if (!isValidElement(node)) return node

  const element = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>
  const props: Record<string, unknown> = {}
  if (typeof element.props.children !== 'undefined') {
    props.children = Children.map(element.props.children, (child) => translateNode(child, language))
  }
  for (const attr of translatableProps) {
    if (typeof element.props[attr] === 'string') props[attr] = translateText(element.props[attr], language)
  }
  return Object.keys(props).length ? cloneElement(element, props) : element
}
