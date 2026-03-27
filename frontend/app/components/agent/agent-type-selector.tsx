import { useState } from 'react'
import { Terminal, Box } from 'lucide-react'
import { cn } from '~/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'

export type AgentType = 'claude_code' | 'codex'

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
    icon: <Terminal className="h-3 w-3 sm:h-3.5 sm:w-3.5" />,
  },
  {
    value: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex via ACP',
    icon: <Box className="h-3 w-3 sm:h-3.5 sm:w-3.5" />,
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
