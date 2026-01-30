import { useState, useEffect, useRef } from 'react'
import { FolderOpen } from 'lucide-react'
import { cn } from '~/lib/utils'
import { api } from '~/lib/api'

interface FolderPickerProps {
  value: string
  onChange: (path: string) => void
  disabled?: boolean
}

export function FolderPicker({ value, onChange, disabled = false }: FolderPickerProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [inputValue, setInputValue] = useState(value)
  const [folders, setFolders] = useState<string[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Fetch top-level folders on mount
  useEffect(() => {
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
          setFolders(['/', ...paths])
        }
      } catch {
        setFolders(['/'])
      }
    }
    fetchFolders()
  }, [])

  // Click outside to close
  useEffect(() => {
    if (!isEditing) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsEditing(false)
        setInputValue(value)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isEditing, value])

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleSelect = (path: string) => {
    onChange(path)
    setInputValue(path)
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onChange(inputValue || '/')
      setIsEditing(false)
    } else if (e.key === 'Escape') {
      setInputValue(value)
      setIsEditing(false)
    }
  }

  const displayValue = value && value !== '/' ? value : '/'

  // Filter folders based on input
  const filteredFolders = folders.filter((f) =>
    f.toLowerCase().includes(inputValue.toLowerCase())
  )

  if (disabled) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground opacity-50">
        <FolderOpen className="h-3.5 w-3.5" />
        <span>{displayValue}</span>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      {isEditing ? (
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5">
            <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className="text-xs bg-transparent border-b border-foreground/30 outline-none w-40"
            />
          </div>
          {filteredFolders.length > 0 && (
            <div className="absolute top-full left-0 mt-1 bg-popover border rounded shadow-md z-50 min-w-40 max-h-48 overflow-auto">
              {filteredFolders.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  onClick={() => handleSelect(folder)}
                  className={cn(
                    'block w-full text-left px-2 py-1 text-xs',
                    'hover:bg-accent transition-colors',
                    folder === value && 'bg-accent'
                  )}
                >
                  {folder}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setInputValue(value)
            setIsEditing(true)
          }}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="truncate max-w-[200px]">{displayValue}</span>
        </button>
      )}
    </div>
  )
}
