import { useState } from 'react'
import { cn } from '~/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import type { AvailableMode } from '~/hooks/use-agent-runtime'

function ClaudeCodeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" clipRule="evenodd" className={className}>
      <path d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" />
    </svg>
  )
}

function CodexIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" clipRule="evenodd" className={className}>
      <path d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" />
    </svg>
  )
}

export type AgentType = 'claude_code' | 'codex'

/** Default modes per agent type, shown before ACP reports real modes. */
export const DEFAULT_MODES: Record<AgentType, AvailableMode[]> = {
  claude_code: [
    { id: 'default', name: 'Default', description: 'Standard behavior, prompts for dangerous operations' },
    { id: 'acceptEdits', name: 'Accept Edits', description: 'Auto-accept file edit operations' },
    { id: 'plan', name: 'Plan Mode', description: 'Planning mode, no actual tool execution' },
    { id: 'dontAsk', name: "Don't Ask", description: "Don't prompt for permissions, deny if not pre-approved" },
    { id: 'bypassPermissions', name: 'Bypass Permissions', description: 'Bypass all permission checks' },
  ],
  codex: [],
}

interface AgentTypeOption {
  value: AgentType
  label: string
  description: string
  icon: React.ReactNode
  disabled?: boolean
}

const AGENT_TYPES: AgentTypeOption[] = [
  {
    value: 'claude_code',
    label: 'Claude Code',
    description: 'Anthropic Claude Code CLI',
    icon: <ClaudeCodeIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />,
  },
  {
    value: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex via ACP',
    icon: <CodexIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />,
  },
]

interface AgentTypeSelectorProps {
  value: AgentType
  onChange: (type: AgentType) => void
  disabled?: boolean
  /** Show label text next to the icon */
  showLabel?: boolean
}

export function AgentTypeSelector({
  value,
  onChange,
  disabled = false,
  showLabel = false,
}: AgentTypeSelectorProps) {
  const [open, setOpen] = useState(false)

  const currentType = AGENT_TYPES.find((t) => t.value === value) ?? AGENT_TYPES[0]

  const handleSelect = (type: AgentType) => {
    onChange(type)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex items-center gap-1 sm:gap-1.5 rounded-lg',
            'text-[11px] sm:text-xs text-muted-foreground',
            'hover:text-foreground hover:bg-foreground/10',
            'cursor-pointer transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            showLabel ? 'px-1.5 sm:px-2 py-1 sm:py-1.5' : 'p-1 sm:p-1.5',
            open && 'bg-accent text-foreground'
          )}
          aria-label={`Agent: ${currentType.label}`}
          title={`${currentType.label}: ${currentType.description}`}
        >
          <span className="shrink-0">{currentType.icon}</span>
          {showLabel && (
            <span className="hidden sm:inline">{currentType.label}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 p-1"
        align="end"
        side="top"
        sideOffset={8}
      >
        <div className="space-y-0.5">
          {AGENT_TYPES.map((type) => (
            <button
              key={type.value}
              type="button"
              onClick={() => !type.disabled && handleSelect(type.value)}
              disabled={type.disabled}
              className={cn(
                'w-full px-2 py-1.5 rounded-md text-left',
                'hover:bg-accent transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                'flex items-start gap-2',
                value === type.value && 'bg-accent',
                type.disabled && 'opacity-50 cursor-not-allowed hover:bg-transparent'
              )}
            >
              <span className="mt-0.5 text-muted-foreground">{type.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">{type.label}</div>
                <div className="text-xs text-muted-foreground">{type.description}</div>
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
