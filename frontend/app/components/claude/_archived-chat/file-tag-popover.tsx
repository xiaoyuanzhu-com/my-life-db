import { useRef, useEffect } from 'react'
import { File, Folder } from 'lucide-react'
import { cn } from '~/lib/utils'
import { Popover, PopoverContent, PopoverAnchor } from '~/components/ui/popover'
import { useAnchorWidth } from './hooks'
import type { FileItem } from './hooks/use-file-tag'

interface FileTagPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  files: FileItem[]
  loading?: boolean
  onSelect: (file: FileItem) => void
  /** Anchor element ref for positioning */
  anchorRef: React.RefObject<HTMLElement | null>
  /** Currently focused item index for keyboard navigation */
  focusIndex?: number
}

export function FileTagPopover({
  open,
  onOpenChange,
  files,
  loading = false,
  onSelect,
  anchorRef,
  focusIndex = 0,
}: FileTagPopoverProps) {
  const listRef = useRef<HTMLDivElement>(null)
  // Create a virtualRef that Radix expects
  const virtualRef = {
    current: anchorRef.current ?? {
      getBoundingClientRect: () => new DOMRect(0, 0, 0, 0),
    },
  }

  // Reactively track anchor width via ResizeObserver — never exceeds input box
  const anchorWidth = useAnchorWidth(anchorRef)

  // Scroll focused item into view
  useEffect(() => {
    if (!open || files.length === 0) return
    const list = listRef.current
    if (!list) return
    const focusedItem = list.children[focusIndex] as HTMLElement | undefined
    if (focusedItem) {
      focusedItem.scrollIntoView({ block: 'nearest' })
    }
  }, [open, focusIndex, files.length])

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
          {loading ? (
            <div className="px-3 py-6 text-sm text-muted-foreground text-center">
              Loading files...
            </div>
          ) : files.length === 0 ? (
            <div className="px-3 py-6 text-sm text-muted-foreground text-center">
              No matching files
            </div>
          ) : (
            <div ref={listRef} className="py-1">
              {files.map((file, index) => {
                const parts = file.path.split('/')
                const filename = parts[parts.length - 1] || file.path
                const parentDir = parts.length > 1 ? parts.slice(0, -1).join('/') : ''

                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => onSelect(file)}
                    className={cn(
                      'w-full px-3 py-2 text-left',
                      'hover:bg-accent transition-colors',
                      'focus:outline-none focus:bg-accent',
                      index === focusIndex && 'bg-accent'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {file.type === 'folder' ? (
                        <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <File className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="text-sm text-foreground truncate shrink-0 max-w-[50%]">
                        {filename}
                      </span>
                      {parentDir && (
                        <span
                          className="text-sm text-muted-foreground truncate ml-auto"
                          style={{ direction: 'rtl', textAlign: 'right' }}
                        >
                          {parentDir}
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
