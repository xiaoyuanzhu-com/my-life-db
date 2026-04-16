import { useRef, useState } from 'react'
import { Check } from 'lucide-react'
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
  const selectedRef = useRef<HTMLButtonElement>(null)

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
        onOpenAutoFocus={(e) => {
          if (selectedRef.current) {
            e.preventDefault()
            selectedRef.current.focus()
          }
        }}
      >
        <div className="space-y-0.5">
          {option.options.map((opt) => {
            const isSelected = option.currentValue === opt.value
            return (
              <button
                key={opt.value}
                ref={isSelected ? selectedRef : undefined}
                type="button"
                onClick={() => handleSelect(opt.value)}
                className={cn(
                  'w-full px-2 py-1.5 rounded-md text-left',
                  'flex items-start gap-2',
                  'hover:bg-accent transition-colors',
                  'focus:outline-none focus:bg-accent'
                )}
              >
                <Check
                  className={cn(
                    'h-4 w-4 shrink-0 mt-0.5 text-primary',
                    !isSelected && 'invisible'
                  )}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">{opt.name}</div>
                  {opt.description && (
                    <div className="text-xs text-muted-foreground">{opt.description}</div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
