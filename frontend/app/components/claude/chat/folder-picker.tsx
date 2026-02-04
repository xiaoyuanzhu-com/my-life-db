import { useState, useEffect, useCallback } from 'react'
import { FolderOpen, Check, Clock } from 'lucide-react'
import { cn } from '~/lib/utils'
import { api } from '~/lib/api'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'

const RECENT_FOLDERS_KEY = 'claude-recent-folders'
const MAX_RECENT_FOLDERS = 3

function getRecentFolders(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(RECENT_FOLDERS_KEY)
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
}

function saveRecentFolder(path: string) {
  if (typeof window === 'undefined' || !path) return
  try {
    const recent = getRecentFolders().filter(p => p !== path)
    recent.unshift(path)
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT_FOLDERS)))
  } catch {
    // ignore
  }
}

interface FolderPickerProps {
  value: string // full path
  onChange?: (path: string) => void // receives full path (optional for readOnly)
  disabled?: boolean
  readOnly?: boolean // if true, just display, not clickable
}

export function FolderPicker({ value, onChange, disabled = false, readOnly = false }: FolderPickerProps) {
  const [open, setOpen] = useState(false)
  const [basePath, setBasePath] = useState('')
  const [currentPath, setCurrentPath] = useState('') // path being browsed
  const [children, setChildren] = useState<string[]>([]) // children of currentPath
  const [recentFolders, setRecentFolders] = useState<string[]>([])

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
        folderOnly: 'true',
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

        // Convert children to full paths (node.path is just the name)
        const responsePath = data.path || ''
        const childPaths = (data.children || []).map(
          (node: { path: string }) => responsePath
            ? `${responseBasePath}/${responsePath}/${node.path}`
            : `${responseBasePath}/${node.path}`
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
        folderOnly: 'true',
        fields: 'path',
      })
      const response = await api.get(`/api/library/tree?${params}`)
      if (response.ok) {
        const data = await response.json()
        const responseBasePath = data.basePath || ''
        setBasePath(responseBasePath)
        if (!value && responseBasePath && onChange) {
          onChange(responseBasePath)
        }
      }
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // When popover opens, fetch children of current value and load recent folders
  useEffect(() => {
    if (open) {
      const pathToBrowse = value || basePath
      setCurrentPath(pathToBrowse)
      fetchChildren(pathToBrowse)
      setRecentFolders(getRecentFolders())
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // When user selects a folder, navigate into it and update value immediately
  const handleSelect = (path: string) => {
    setCurrentPath(path)
    fetchChildren(path)
    if (onChange) {
      onChange(path)
    }
  }

  // Select a folder and close the popover (used for recent folders quick select)
  const handleQuickSelect = (path: string) => {
    saveRecentFolder(path)
    if (onChange) {
      onChange(path)
    }
    setOpen(false)
  }

  // Save to recent when popover closes with a selection
  useEffect(() => {
    if (!open && value) {
      saveRecentFolder(value)
    }
  }, [open, value])

  const getLastSegment = (path: string) => {
    const segments = path.split('/').filter(Boolean)
    return segments[segments.length - 1] || ''
  }

  // Get last N segments for display (e.g., "data/bookmarks" instead of full path)
  const getLastNSegments = (path: string, n: number) => {
    if (!path) return ''
    if (n <= 0) return ''
    const segments = path.split('/').filter(Boolean)
    if (segments.length === 0) return ''
    return segments.slice(-n).join('/')
  }

  const displayValue = value ? getLastSegment(value) : '.'

  // Read-only mode: display only, same visual style but not interactive
  if (readOnly) {
    return (
      <div
        className={cn(
          'flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-1 sm:py-1.5 rounded-lg',
          'text-[11px] sm:text-xs text-muted-foreground',
          'hover:text-foreground hover:bg-foreground/10',
          'cursor-pointer transition-colors',
          disabled && 'opacity-50'
        )}
      >
        <FolderOpen className="h-3 w-3 sm:h-3.5 sm:w-3.5 shrink-0" />
        <span className="truncate max-w-[100px] sm:max-w-[200px]">{displayValue}</span>
      </div>
    )
  }

  // Get parent path (stop at basePath - the data directory)
  const getParentPath = (path: string) => {
    if (!path) return null
    // Don't show ".." when at basePath (data directory is the root)
    if (path === basePath) return null
    const lastSlash = path.lastIndexOf('/')
    if (lastSlash <= 0) return null
    return path.slice(0, lastSlash)
  }

  // Build full list: [parent?, current, ...children]
  const parentPath = getParentPath(currentPath)
  const options = [
    ...(parentPath ? [parentPath] : []),
    ...(currentPath ? [currentPath] : []),
    ...children,
  ]

  // Filter recent folders to exclude those already in browse list
  const optionsSet = new Set(options)
  const filteredRecentFolders = recentFolders.filter(folder => !optionsSet.has(folder))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-1 sm:py-1.5 rounded-lg',
            'text-[11px] sm:text-xs text-muted-foreground',
            'hover:text-foreground hover:bg-foreground/10',
            'cursor-pointer transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          <FolderOpen className="h-3 w-3 sm:h-3.5 sm:w-3.5 shrink-0" />
          <span className="truncate max-w-[100px] sm:max-w-[200px]">{displayValue}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start" side="top">
        <div className="max-h-64 overflow-y-auto">
          {/* Recent folders section - only show if there are filtered recent folders */}
          {filteredRecentFolders.length > 0 && (
            <>
              <div className="px-2 py-1 text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Recent
              </div>
              <div className="space-y-0.5 mb-1">
                {filteredRecentFolders.map((folder) => (
                  <button
                    key={`recent-${folder}`}
                    type="button"
                    onClick={() => handleQuickSelect(folder)}
                    className={cn(
                      'w-full px-2 py-1.5 rounded-md text-left text-sm',
                      'hover:bg-accent transition-colors',
                      'focus:outline-none focus:bg-accent',
                      'flex items-center justify-between',
                      folder === value && 'bg-accent'
                    )}
                  >
                    <span className="truncate">{getLastNSegments(folder, 2)}</span>
                    {folder === value && <Check className="h-4 w-4 text-muted-foreground shrink-0" />}
                  </button>
                ))}
              </div>
              <div className="border-t border-border my-1" />
            </>
          )}

          {/* Browse section */}
          <div className="space-y-0.5">
            {options.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No subfolders</div>
            ) : (
              options.map((folder) => {
                // Display: ".." for parent, 1 segment for current, 2 segments for children
                const isParent = folder === parentPath
                const isCurrent = folder === currentPath
                const displayName = isParent
                  ? '..'
                  : isCurrent
                    ? getLastSegment(folder)
                    : getLastNSegments(folder, 2)
                return (
                  <button
                    key={folder}
                    type="button"
                    onClick={() => handleSelect(folder)}
                    className={cn(
                      'w-full px-2 py-1.5 rounded-md text-left text-sm',
                      'hover:bg-accent transition-colors',
                      'focus:outline-none focus:bg-accent',
                      'flex items-center justify-between',
                      isCurrent && 'bg-accent'
                    )}
                  >
                    <span>{displayName}</span>
                    {isCurrent && <Check className="h-4 w-4 text-muted-foreground" />}
                  </button>
                )
              })
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
