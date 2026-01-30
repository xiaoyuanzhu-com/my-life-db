import { useState, useEffect, useRef, useCallback } from 'react'
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
  const [basePath, setBasePath] = useState('')
  const [currentPath, setCurrentPath] = useState('') // path being browsed
  const [children, setChildren] = useState<string[]>([]) // children of currentPath
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Fetch children of a given full path
  const fetchChildren = useCallback(async (fullPath: string, knownBasePath?: string) => {
    try {
      const base = knownBasePath || basePath
      // Convert full path to relative path for API
      const relativePath = base && fullPath.startsWith(base)
        ? fullPath.slice(base.length + 1) // +1 for the /
        : ''

      const params = new URLSearchParams({
        path: relativePath,
        depth: '1',
        folder_only: 'true',
        fields: 'path',
      })

      const response = await api.get(`/api/library/tree?${params}`)
      if (response.ok) {
        const data = await response.json()
        const responseBasePath = data.basePath || ''

        // Store basePath if not yet known
        if (!basePath && responseBasePath) {
          setBasePath(responseBasePath)
        }

        // Convert children to full paths
        const childPaths = (data.children || []).map(
          (node: { path: string }) => `${responseBasePath}/${node.path}`
        )
        setChildren(childPaths)

        return responseBasePath
      }
    } catch {
      // keep empty
    }
    return null
  }, [basePath])

  // Fetch basePath on mount to initialize value if empty
  useEffect(() => {
    const init = async () => {
      const params = new URLSearchParams({
        depth: '0',
        folder_only: 'true',
        fields: 'path',
      })
      const response = await api.get(`/api/library/tree?${params}`)
      if (response.ok) {
        const data = await response.json()
        const responseBasePath = data.basePath || ''
        setBasePath(responseBasePath)
        if (!value && responseBasePath) {
          onChange(responseBasePath)
        }
      }
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // When popover opens, fetch children of current value
  useEffect(() => {
    if (open) {
      const pathToBrowse = value || basePath
      setCurrentPath(pathToBrowse)
      setSearch(pathToBrowse)
      fetchChildren(pathToBrowse)

      // Move cursor to end
      requestAnimationFrame(() => {
        const input = inputRef.current
        if (input) {
          const len = pathToBrowse.length
          input.setSelectionRange(len, len)
        }
      })
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // When user selects a folder, navigate into it
  const handleSelect = (path: string) => {
    setCurrentPath(path)
    setSearch(path)
    fetchChildren(path)

    // Move cursor to end
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (input) {
        const len = path.length
        input.setSelectionRange(len, len)
      }
    })
  }

  // When popover closes, confirm selection
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && currentPath && currentPath !== value) {
      onChange(currentPath)
    }
    setOpen(newOpen)
  }

  const getLastSegment = (path: string) => {
    const segments = path.split('/').filter(Boolean)
    return segments[segments.length - 1] || ''
  }

  // Fuzzy match: characters must appear in order, not necessarily contiguous
  const fuzzyMatch = (text: string, pattern: string) => {
    const lowerText = text.toLowerCase()
    const lowerPattern = pattern.toLowerCase()
    let patternIdx = 0
    for (let i = 0; i < lowerText.length && patternIdx < lowerPattern.length; i++) {
      if (lowerText[i] === lowerPattern[patternIdx]) {
        patternIdx++
      }
    }
    return patternIdx === lowerPattern.length
  }

  const displayValue = value ? getLastSegment(value) : '.'

  // Get parent path (allow navigating above basePath)
  const getParentPath = (path: string) => {
    if (!path) return null
    const lastSlash = path.lastIndexOf('/')
    // Stop at root "/"
    if (lastSlash <= 0) return null
    return path.slice(0, lastSlash)
  }

  // Build full list: [parent?, current, ...filtered children]
  const parentPath = getParentPath(currentPath)
  const filteredChildren = children.filter((path) => fuzzyMatch(path, search))
  const filteredOptions = [
    // Parent and current always shown (not filtered)
    ...(parentPath ? [parentPath] : []),
    ...(currentPath ? [currentPath] : []),
    // Only children are filtered
    ...filteredChildren,
  ]

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
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
            placeholder="Navigate folders..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No subfolders</CommandEmpty>
            <CommandGroup>
              {filteredOptions.map((folder) => (
                <CommandItem
                  key={folder}
                  value={folder}
                  onSelect={() => handleSelect(folder)}
                  className={cn(folder === currentPath && 'bg-accent')}
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
