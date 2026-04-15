import { useState } from 'react'
import { cn } from '~/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import type { AvailableModel } from '~/hooks/use-agent-runtime'

interface ModelSelectorProps {
  value: string
  models: AvailableModel[]
  onChange: (model: string) => void
  disabled?: boolean
}

export function ModelSelector({
  value,
  models,
  onChange,
  disabled = false,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false)

  const currentModel = models.find((m) => m.id === value) ?? models[0]
  if (!currentModel) return null

  const handleSelect = (model: string) => {
    onChange(model)
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
          aria-label={`Model: ${currentModel.name}`}
          title={`${currentModel.name}: ${currentModel.description}`}
        >
          <span>{currentModel.name}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-1"
        align="end"
        side="top"
        sideOffset={8}
      >
        <div className="space-y-0.5">
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => handleSelect(model.id)}
              className={cn(
                'w-full px-2 py-1.5 rounded-md text-left',
                'hover:bg-accent transition-colors',
                'focus:outline-none focus:bg-accent',
                value === model.id && 'bg-accent'
              )}
            >
              <div className="text-sm font-medium text-foreground">{model.name}</div>
              <div className="text-xs text-muted-foreground">{model.description}</div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
