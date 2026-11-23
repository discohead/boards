import { useState, type ReactNode } from 'react'
import { Tabs as UITabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Icon, type IconProp } from './icon'

export interface TabsProps {
  tabs: { id: string; label: string; count?: number; add?: boolean; onAdd?: () => void; icon?: IconProp }[]
  value?: string
  onChange?: (id: string) => void
  /** Panels (TabsContent from '@/components/ui/tabs'), if the tabs own them. */
  children?: ReactNode
  className?: string
}

/**
 * The faces of a thread (Conversation, Task, Doc) and a seat doc's sections. A face the thread
 * doesn't have yet is an add action ("+ Write it up"), never an empty tab. Keep the open tab in
 * the URL: pass value and onChange.
 */
export function Tabs({ tabs, value, onChange, children, className }: TabsProps) {
  const [own, setOwn] = useState(() => tabs.find((t) => !t.add)?.id)
  const current = value ?? own
  return (
    <UITabs
      value={current}
      onValueChange={(id) => {
        setOwn(id)
        onChange?.(id)
      }}
      className={className}
    >
      <TabsList>
        {tabs.map((t) =>
          t.add ? (
            <button
              key={t.id}
              type="button"
              onClick={t.onAdd}
              className="-mb-px inline-flex cursor-pointer items-center gap-1.5 border-b-2 border-transparent py-2 text-[12px] whitespace-nowrap text-muted-foreground opacity-80 transition-fast hover:text-text"
            >
              {t.icon ? <Icon name={t.icon} size={14} /> : '+ '}
              {t.label}
            </button>
          ) : (
            <TabsTrigger key={t.id} value={t.id}>
              {t.icon ? <Icon name={t.icon} size={14} /> : null}
              {t.label}
              {t.count != null ? (
                <span className="rounded-xs border border-line px-[5px] font-mono text-mono-label text-muted-foreground tabular-nums">{t.count}</span>
              ) : null}
            </TabsTrigger>
          ),
        )}
      </TabsList>
      {children}
    </UITabs>
  )
}
