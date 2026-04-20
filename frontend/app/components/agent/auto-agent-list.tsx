import { useCallback, useEffect, useState } from 'react'
import { Clock, File, Hand, Bot } from 'lucide-react'
import { cn } from '~/lib/utils'
import { api } from '~/lib/api'

export interface AutoAgentSummary {
  name: string
  agent: string
  trigger: string
  schedule?: string
  path?: string
  enabled: boolean
}

interface Props {
  activeName: string | null
  onSelect: (name: string) => void
  /** Bumped by the parent to force a refetch after mutations. */
  refreshKey?: number
}

function triggerIcon(trigger: string) {
  if (trigger === 'cron') return Clock
  if (trigger === 'manual') return Hand
  if (trigger.startsWith('file.')) return File
  return Bot
}

function triggerSummary(def: AutoAgentSummary): string {
  if (def.trigger === 'cron') return def.schedule ? `every ${def.schedule}` : 'cron'
  if (def.trigger === 'manual') return 'manual'
  if (def.trigger.startsWith('file.')) {
    const event = def.trigger.replace('file.', 'on ')
    return def.path ? `${event} · ${def.path}` : event
  }
  return def.trigger
}

export function AutoAgentList({ activeName, onSelect, refreshKey = 0 }: Props) {
  const [defs, setDefs] = useState<AutoAgentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await api.get('/api/agent/defs')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setDefs(data.defs ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  if (loading && defs.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>
  }

  if (error) {
    return <div className="p-4 text-sm text-destructive">{error}</div>
  }

  if (defs.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No auto agents yet. Create one to get started.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      {defs.map((def) => {
        const Icon = triggerIcon(def.trigger)
        const isActive = activeName === def.name
        return (
          <button
            key={def.name}
            onClick={() => onSelect(def.name)}
            className={cn(
              'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted',
              isActive && 'bg-muted'
            )}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{def.name}</span>
                {!def.enabled && (
                  <span className="rounded bg-muted-foreground/15 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    off
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {triggerSummary(def)}
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
