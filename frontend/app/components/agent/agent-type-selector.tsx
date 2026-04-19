import { useState } from 'react'
import { cn } from '~/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import type { AvailableMode } from '~/hooks/use-agent-runtime'
import ClaudeCodeIcon from '@thesvg/react/claude-code'
import CodexIcon from '@thesvg/react/codex-openai'
import QwenBrand from '@thesvg/react/qwen'
import GeminiIcon from '@thesvg/react/gemini-cli'
import OpencodeIcon from '@thesvg/react/opencode'

// Qwen's upstream SVG has fill="#ffff" (white), invisible on our background.
// Wrap to force currentColor so parent text color controls it.
function QwenIcon(props: React.SVGProps<SVGSVGElement>) {
  return <QwenBrand {...props} fill="currentColor" />
}

export type AgentType = 'claude_code' | 'codex' | 'qwen' | 'gemini' | 'opencode'

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
  qwen: [],
  gemini: [],
  opencode: [],
}

interface AgentTypeOption {
  value: AgentType
  label: string
  icon: React.ReactNode
  disabled?: boolean
}

const AGENT_TYPES: AgentTypeOption[] = [
  {
    value: 'claude_code',
    label: 'Claude Code',
    icon: <ClaudeCodeIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />,
  },
  {
    value: 'codex',
    label: 'Codex CLI',
    icon: <CodexIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />,
  },
  {
    value: 'qwen',
    label: 'Qwen Code',
    icon: <QwenIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />,
  },
  {
    value: 'gemini',
    label: 'Gemini CLI',
    icon: <GeminiIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />,
  },
  {
    value: 'opencode',
    label: 'OpenCode',
    icon: <OpencodeIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />,
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
          title={currentType.label}
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
                'flex items-center gap-2',
                value === type.value && 'bg-accent',
                type.disabled && 'opacity-50 cursor-not-allowed hover:bg-transparent'
              )}
            >
              <span className="text-muted-foreground">{type.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">{type.label}</div>
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
