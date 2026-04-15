import { useState } from 'react'
import { cn } from '~/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import type { ConfigOption } from '~/hooks/use-agent-runtime'

interface ConfigOptionSelectorProps {
  option: ConfigOption
  onChange: (value: string) => void
  disabled?: boolean
}

export function ConfigOptionSelector({
  option,
  onChange,
  disabled = false,
}: ConfigOptionSelectorProps) {
  const [open, setOpen] = useState(false)

  const current = option.options.find((o) => o.value === option.currentValue) ?? option.options[0]
  if (!current) return null

  const handleSelect = (value: string) => {
    onChange(value)
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
          aria-label={`${option.name}: ${current.name}`}
          title={current.description || `${option.name}: ${current.name}`}
        >
          <span>{current.name}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-1"
        align="end"
        side="top"
        sideOffset={8}
      >
        <div className="space-y-0.5">
          {option.options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleSelect(opt.value)}
              className={cn(
                'w-full px-2 py-1.5 rounded-md text-left',
                'hover:bg-accent transition-colors',
                'focus:outline-none focus:bg-accent',
                option.currentValue === opt.value && 'bg-accent'
              )}
            >
              <div className="text-sm font-medium text-foreground">{opt.name}</div>
              {opt.description && (
                <div className="text-xs text-muted-foreground">{opt.description}</div>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
