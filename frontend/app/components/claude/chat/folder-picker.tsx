import { useState, useEffect, useRef } from 'react'
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
  value: string // full path
  onChange: (path: string) => void // receives full path
  disabled?: boolean
}

export function FolderPicker({ value, onChange, disabled = false }: FolderPickerProps) {
  const [open, setOpen] = useState(false)
  const [folders, setFolders] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset search to current value when popover opens, cursor at end
  useEffect(() => {
    if (open) {
      setSearch(value)
      // Move cursor to end after React updates the input
      requestAnimationFrame(() => {
        const input = inputRef.current
        if (input) {
          const len = value.length
          input.setSelectionRange(len, len)
        }
      })
    }
  }, [open, value])

  // Fetch tree on mount to initialize value and get folder list
  useEffect(() => {
    const fetchTree = async () => {
      try {
        const params = new URLSearchParams({
          depth: '1',
          folder_only: 'true',
          fields: 'path',
        })
        const response = await api.get(`/api/library/tree?${params}`)
        if (response.ok) {
          const data = await response.json()
          const basePath = data.basePath || ''
          const childPaths = (data.children || []).map(
            (node: { path: string }) => `${basePath}/${node.path}`
          )
          setFolders([basePath, ...childPaths])
          // Initialize value to basePath if empty
          if (!value && basePath) {
            onChange(basePath)
          }
        }
      } catch {
        // keep empty
      }
    }
    fetchTree()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelect = (path: string) => {
    onChange(path)
    setOpen(false)
  }

  const getLastSegment = (path: string) => {
    const segments = path.split('/').filter(Boolean)
    return segments[segments.length - 1] || ''
  }

  const displayValue = value ? getLastSegment(value) : '.'

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
      <PopoverContent className="w-80 p-0" align="start" side="top">
        <Command shouldFilter={false}>
          <CommandInput
            ref={inputRef}
            placeholder="Search folders..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No folders found</CommandEmpty>
            <CommandGroup>
              {folders
                .filter((folder) =>
                  folder.toLowerCase().includes(search.toLowerCase())
                )
                .map((folder) => (
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
