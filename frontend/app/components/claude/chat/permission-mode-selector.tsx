import { useState } from 'react'
import { Shield, ShieldCheck, ShieldOff, FileEdit } from 'lucide-react'
import { cn } from '~/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

interface PermissionModeOption {
  value: PermissionMode
  label: string
  description: string
  icon: React.ReactNode
}

const PERMISSION_MODES: PermissionModeOption[] = [
  {
    value: 'default',
    label: 'Ask before edits',
    description: 'Prompts for tool permissions',
    icon: <Shield className="h-4 w-4" />,
  },
  {
    value: 'acceptEdits',
    label: 'Edit automatically',
    description: 'Auto-accepts file edits',
    icon: <FileEdit className="h-4 w-4" />,
  },
  {
    value: 'plan',
    label: 'Plan mode',
    description: 'No tool execution',
    icon: <ShieldCheck className="h-4 w-4" />,
  },
  {
    value: 'bypassPermissions',
    label: 'YOLO',
    description: 'All tools auto-approved',
    icon: <ShieldOff className="h-4 w-4" />,
  },
]

interface PermissionModeSelectorProps {
  value: PermissionMode
  onChange: (mode: PermissionMode) => void
  disabled?: boolean
  /** Show label text next to the icon */
  showLabel?: boolean
}

export function PermissionModeSelector({
  value,
  onChange,
  disabled = false,
  showLabel = false,
}: PermissionModeSelectorProps) {
  const [open, setOpen] = useState(false)

  const currentMode = PERMISSION_MODES.find((m) => m.value === value) ?? PERMISSION_MODES[0]

  const handleSelect = (mode: PermissionMode) => {
    onChange(mode)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'rounded-lg',
            'flex items-center justify-center gap-1.5',
            'text-muted-foreground hover:text-foreground hover:bg-foreground/10',
            'cursor-pointer transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            showLabel ? 'h-8 px-2.5' : 'h-8 w-8',
            open && 'bg-accent text-foreground'
          )}
          aria-label={`Permission mode: ${currentMode.label}`}
          title={`${currentMode.label}: ${currentMode.description}`}
        >
          {currentMode.icon}
          {showLabel && <span className="text-xs">{currentMode.label}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 p-1"
        align="end"
        side="top"
        sideOffset={8}
      >
        <div className="space-y-0.5">
          {PERMISSION_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              onClick={() => handleSelect(mode.value)}
              className={cn(
                'w-full px-2 py-1.5 rounded-md text-left',
                'hover:bg-accent transition-colors',
                'focus:outline-none focus:bg-accent',
                'flex items-start gap-2',
                value === mode.value && 'bg-accent'
              )}
            >
              <span className="mt-0.5 text-muted-foreground">{mode.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">{mode.label}</div>
                <div className="text-xs text-muted-foreground">{mode.description}</div>
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
