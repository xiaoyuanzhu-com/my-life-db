import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { cn } from '~/lib/utils'
import { api } from '~/lib/api'
import { Avatar, AvatarFallback } from '~/components/ui/avatar'

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
  /** Invoked when the user clicks the trailing "+" card to create an agent. */
  onCreate?: () => void
  /** Bumped by the parent to force a refetch after mutations. */
  refreshKey?: number
}

// Palette used to give each agent a consistent persona color derived from
// its name. Hand-picked for pleasant contrast in both light and dark modes.
const PERSONA_COLORS = [
  'bg-rose-500/90 text-white',
  'bg-amber-500/90 text-white',
  'bg-emerald-500/90 text-white',
  'bg-sky-500/90 text-white',
  'bg-violet-500/90 text-white',
  'bg-pink-500/90 text-white',
  'bg-teal-500/90 text-white',
  'bg-indigo-500/90 text-white',
  'bg-orange-500/90 text-white',
  'bg-lime-500/90 text-white',
]

function personaColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return PERSONA_COLORS[hash % PERSONA_COLORS.length]
}

function personaInitials(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, ' ').trim()
  if (!clean) return '?'
  const parts = clean.split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return clean.slice(0, 2).toUpperCase()
}


export function AutoAgentList({ activeName, onSelect, onCreate, refreshKey = 0 }: Props) {
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

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-6 p-4">
      {defs.map((def) => {
        const isActive = activeName === def.name
        return (
          <button
            key={def.name}
            onClick={() => onSelect(def.name)}
            className={cn(
              'flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors hover:bg-muted',
              isActive && 'bg-muted'
            )}
          >
            <Avatar size="lg" className="size-14">
              <AvatarFallback className={cn('text-base font-semibold', personaColor(def.name))}>
                {personaInitials(def.name)}
              </AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="line-clamp-2 text-sm font-medium break-words">{def.name}</span>
              {!def.enabled && (
                <span className="shrink-0 rounded bg-muted-foreground/15 px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                  off
                </span>
              )}
            </div>
          </button>
        )
      })}
      {onCreate && (
        <button
          onClick={onCreate}
          className="flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors hover:bg-muted"
          title="Create a new auto agent with AI"
        >
          <Avatar size="lg" className="size-14">
            <AvatarFallback className="bg-muted text-muted-foreground border border-dashed border-muted-foreground/40">
              <Plus className="h-5 w-5" />
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="line-clamp-2 text-sm font-medium break-words text-muted-foreground">
              New
            </span>
          </div>
        </button>
      )}
    </div>
  )
}
