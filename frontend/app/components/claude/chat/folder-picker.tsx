import { useState, useEffect } from 'react'
import { FolderOpen } from 'lucide-react'
import { cn } from '~/lib/utils'
import { api } from '~/lib/api'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '~/components/ui/command'

interface FolderPickerProps {
  value: string
  onChange: (path: string) => void
  disabled?: boolean
}

export function FolderPicker({ value, onChange, disabled = false }: FolderPickerProps) {
  const [open, setOpen] = useState(false)
  const [folders, setFolders] = useState<string[]>(['.'])

  // Fetch folders when popover opens
  useEffect(() => {
    if (!open) return
    const fetchFolders = async () => {
      try {
        const params = new URLSearchParams({
          depth: '1',
          folder_only: 'true',
          fields: 'path',
        })
        const response = await api.get(`/api/library/tree?${params}`)
        if (response.ok) {
          const data = await response.json()
          const paths = (data.children || [])
            .filter((node: { type: string }) => node.type === 'folder')
            .map((node: { path: string }) => node.path)
          setFolders(['.', ...paths])
        }
      } catch {
        // keep default ['.']
      }
    }
    fetchFolders()
  }, [open])

  const handleSelect = (path: string) => {
    onChange(path)
    setOpen(false)
  }

  const displayValue = value && value !== '.' ? value : '.'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex items-center gap-1.5 text-xs text-muted-foreground',
            'hover:text-foreground transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="truncate max-w-[200px]">{displayValue}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" align="start" side="top">
        <Command>
          <CommandInput placeholder="Search folders..." />
          <CommandList>
            <CommandEmpty>No folders found</CommandEmpty>
            <CommandGroup>
              {folders.map((folder) => (
                <CommandItem
                  key={folder}
                  value={folder}
                  onSelect={() => handleSelect(folder)}
                  className={cn(folder === value && 'bg-accent')}
                >
                  {folder}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
