import { useState, useEffect, useCallback } from 'react'
import { FolderOpen, Folder, ChevronRight, Check, Loader2 } from 'lucide-react'
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

interface FolderNode {
  name: string
  path: string
  type: 'folder'
}

interface FolderPickerProps {
  /** Current selected folder path */
  value: string
  /** Callback when folder is selected and confirmed */
  onChange: (path: string) => void
  /** Whether the picker is disabled */
  disabled?: boolean
}

export function FolderPicker({ value, onChange, disabled = false }: FolderPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [currentPath, setCurrentPath] = useState('')
  const [folders, setFolders] = useState<FolderNode[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // Fetch folders for the current path
  const fetchFolders = useCallback(async (path: string) => {
    setIsLoading(true)
    try {
      const params = new URLSearchParams({
        depth: '1',
        folder_only: 'true',
        fields: 'name,path,type',
      })
      if (path) {
        params.set('path', path)
      }
      const response = await api.get(`/api/library/tree?${params}`)
      if (response.ok) {
        const data = await response.json()
        // Filter to only folders (in case folder_only isn't supported)
        const folderChildren = (data.children || []).filter(
          (node: FolderNode) => node.type === 'folder'
        )
        setFolders(folderChildren)
      } else {
        setFolders([])
      }
    } catch {
      setFolders([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Load folders when popover opens or path changes
  useEffect(() => {
    if (isOpen) {
      fetchFolders(currentPath)
    }
  }, [isOpen, currentPath, fetchFolders])

  // Reset to root when opening
  const handleOpenChange = (open: boolean) => {
    if (open) {
      setCurrentPath('')
    }
    setIsOpen(open)
  }

  // Navigate into a folder
  const handleNavigateInto = (folder: FolderNode) => {
    setCurrentPath(folder.path)
  }

  // Navigate back to parent
  const handleNavigateBack = () => {
    const parts = currentPath.split('/')
    parts.pop()
    setCurrentPath(parts.join('/'))
  }

  // Confirm selection of current path
  const handleSelect = () => {
    onChange(currentPath || '/')
    setIsOpen(false)
  }

  // Build breadcrumb segments
  const pathSegments = currentPath ? currentPath.split('/') : []

  // Navigate to a specific breadcrumb segment
  const handleBreadcrumbClick = (index: number) => {
    if (index === -1) {
      // Root
      setCurrentPath('')
    } else {
      const newPath = pathSegments.slice(0, index + 1).join('/')
      setCurrentPath(newPath)
    }
  }

  // Display path for the trigger button
  const displayPath = value || 'Select folder...'

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
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
          <span className="truncate max-w-[200px]">{displayPath}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        {/* Breadcrumb navigation */}
        <div className="flex items-center gap-1 px-3 py-2 border-b text-xs text-muted-foreground overflow-x-auto">
          <button
            type="button"
            onClick={() => handleBreadcrumbClick(-1)}
            className={cn(
              'hover:text-foreground transition-colors shrink-0',
              currentPath === '' && 'text-foreground font-medium'
            )}
          >
            Root
          </button>
          {pathSegments.map((segment, index) => (
            <span key={index} className="flex items-center gap-1 shrink-0">
              <ChevronRight className="h-3 w-3" />
              <button
                type="button"
                onClick={() => handleBreadcrumbClick(index)}
                className={cn(
                  'hover:text-foreground transition-colors',
                  index === pathSegments.length - 1 && 'text-foreground font-medium'
                )}
              >
                {segment}
              </button>
            </span>
          ))}
        </div>

        {/* Command with search and folder list */}
        <Command>
          <CommandInput placeholder="Search folders..." />
          <CommandList>
            <CommandEmpty>No folders found</CommandEmpty>
            <CommandGroup>
              {/* Back navigation */}
              {currentPath && (
                <CommandItem onSelect={handleNavigateBack} className="text-muted-foreground">
                  <span className="mr-2">..</span>
                  <span>Back</span>
                </CommandItem>
              )}

              {/* Loading state */}
              {isLoading && (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}

              {/* Folder list */}
              {!isLoading &&
                folders.map((folder) => (
                  <CommandItem
                    key={folder.path}
                    value={folder.name}
                    onSelect={() => handleNavigateInto(folder)}
                    className="flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2">
                      <Folder className="h-4 w-4 text-muted-foreground" />
                      <span>{folder.name}</span>
                    </div>
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
        </Command>

        {/* Footer with select button */}
        <div className="flex items-center justify-between border-t px-3 py-2">
          <span className="text-xs text-muted-foreground truncate max-w-[180px]">
            {currentPath || '/'}
          </span>
          <button
            type="button"
            onClick={handleSelect}
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded text-xs',
              'bg-primary text-primary-foreground',
              'hover:bg-primary/90 transition-colors'
            )}
          >
            <Check className="h-3 w-3" />
            <span>Select</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
