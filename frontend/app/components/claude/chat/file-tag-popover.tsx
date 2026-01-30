import { File, Folder } from 'lucide-react'
import { cn } from '~/lib/utils'
import { Popover, PopoverContent, PopoverAnchor } from '~/components/ui/popover'
import type { FileItem } from './hooks/use-file-tag'

interface FileTagPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  files: FileItem[]
  loading?: boolean
  onSelect: (file: FileItem) => void
  /** Anchor element ref for positioning */
  anchorRef: React.RefObject<HTMLElement | null>
}

export function FileTagPopover({
  open,
  onOpenChange,
  files,
  loading = false,
  onSelect,
  anchorRef,
}: FileTagPopoverProps) {
  // Create a virtualRef that Radix expects
  const virtualRef = {
    current: anchorRef.current ?? {
      getBoundingClientRect: () => new DOMRect(0, 0, 0, 0),
    },
  }

  const anchorWidth = anchorRef.current?.offsetWidth ?? 320

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        className="p-0 max-h-80 overflow-hidden"
        style={{ width: anchorWidth }}
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
            <div className="py-1">
              {files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => onSelect(file)}
                  className={cn(
                    'w-full px-3 py-2 text-left',
                    'hover:bg-accent transition-colors',
                    'focus:outline-none focus:bg-accent'
                  )}
                >
                  <div className="flex items-center gap-2">
                    {file.type === 'folder' ? (
                      <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <File className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <span className="text-sm text-foreground truncate">{file.path}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
