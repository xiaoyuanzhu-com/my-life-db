import { useState } from 'react'
import { cn } from '~/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import type { AvailableMode } from '~/hooks/use-agent-runtime'

export type PermissionMode = string

interface PermissionModeSelectorProps {
  value: PermissionMode
  modes: AvailableMode[]
  onChange: (mode: PermissionMode) => void
  disabled?: boolean
}

export function PermissionModeSelector({
  value,
  modes,
  onChange,
  disabled = false,
}: PermissionModeSelectorProps) {
  const [open, setOpen] = useState(false)

  const currentMode = modes.find((m) => m.id === value) ?? modes[0]
  if (!currentMode) return null

  const handleSelect = (mode: string) => {
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
            'flex items-center gap-1 sm:gap-1.5 rounded-lg',
            'text-[11px] sm:text-xs text-muted-foreground',
            'hover:text-foreground hover:bg-foreground/10',
            'cursor-pointer transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'px-1.5 sm:px-2 py-1 sm:py-1.5',
            open && 'bg-accent text-foreground'
          )}
          aria-label={`Permission mode: ${currentMode.name}`}
          title={`${currentMode.name}: ${currentMode.description}`}
        >
          <span>{currentMode.name}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 p-1"
        align="end"
        side="top"
        sideOffset={8}
      >
        <div className="space-y-0.5">
          {modes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => handleSelect(mode.id)}
              className={cn(
                'w-full px-2 py-1.5 rounded-md text-left',
                'hover:bg-accent transition-colors',
                'focus:outline-none focus:bg-accent',
                value === mode.id && 'bg-accent'
              )}
            >
              <div className="text-sm font-medium text-foreground">{mode.name}</div>
              <div className="text-xs text-muted-foreground">{mode.description}</div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
