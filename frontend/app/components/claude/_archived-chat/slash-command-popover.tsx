import { cn } from '~/lib/utils'
import { Popover, PopoverContent, PopoverAnchor } from '~/components/ui/popover'
import { useAnchorWidth } from './hooks'
import type { SlashCommand } from './slash-commands'

interface SlashCommandPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: SlashCommand[]
  onSelect: (command: SlashCommand) => void
  /** Anchor element ref for positioning (container to match width) */
  anchorRef: React.RefObject<HTMLElement | null>
}

export function SlashCommandPopover({
  open,
  onOpenChange,
  commands,
  onSelect,
  anchorRef,
}: SlashCommandPopoverProps) {
  // Create a virtualRef that Radix expects (non-nullable Measurable)
  const virtualRef = {
    current: anchorRef.current ?? {
      getBoundingClientRect: () => new DOMRect(0, 0, 0, 0),
    },
  }

  // Reactively track anchor width via ResizeObserver — never exceeds input box
  const anchorWidth = useAnchorWidth(anchorRef)

  // Don't render the popover content until anchor is measured
  if (!anchorWidth) return null

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        className="p-0 max-h-80 overflow-hidden duration-0"
        style={{ width: anchorWidth, maxWidth: anchorWidth }}
        align="start"
        side="top"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="overflow-y-auto max-h-80">
          {commands.length === 0 ? (
            <div className="px-3 py-6 text-sm text-muted-foreground text-center">
              No matching commands
            </div>
          ) : (
            <div className="py-1">
              {commands.map((cmd) => (
                <button
                  key={cmd.name}
                  type="button"
                  onClick={() => onSelect(cmd)}
                  className={cn(
                    'w-full px-3 py-2 text-left',
                    'hover:bg-accent transition-colors',
                    'focus:outline-none focus:bg-accent'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">/{cmd.name}</span>
                    {cmd.source === 'skill' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        skill
                      </span>
                    )}
                  </div>
                  {cmd.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                      {cmd.description}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
