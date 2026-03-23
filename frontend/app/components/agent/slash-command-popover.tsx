/**
 * SlashCommandPopover — triggered when user types "/" at the start of input
 * or at start of a token in the composer.
 *
 * Shows filtered list of available commands. On select, replaces the /token
 * with the command text.
 *
 * Uses a simple absolute-positioned div (not Radix Popover) because we need
 * tight control over position relative to the textarea.
 */
import { useState, useEffect, useCallback, useRef } from "react"
import { useComposerRuntime, useComposer } from "@assistant-ui/react"
import { cn } from "~/lib/utils"

// Default slash commands (can be extended with sessionMeta.commands)
const DEFAULT_COMMANDS = [
  { name: "/help", description: "Show available commands" },
  { name: "/clear", description: "Clear conversation" },
  { name: "/compact", description: "Compact conversation history" },
  { name: "/init", description: "Initialize from CLAUDE.md" },
]

interface SlashCommandPopoverProps {
  /** Additional commands from session metadata */
  commands?: Array<{ name: string; description?: string }>
  /** Reference to the textarea element for positioning */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

export function SlashCommandPopover({ commands, textareaRef }: SlashCommandPopoverProps) {
  const composerRuntime = useComposerRuntime()
  const text = useComposer((s) => s.text)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const popoverRef = useRef<HTMLDivElement>(null)

  const allCommands = [
    ...DEFAULT_COMMANDS,
    ...(commands ?? []).map((c) => ({
      name: typeof c.name === "string" ? (c.name.startsWith("/") ? c.name : `/${c.name}`) : `/${c}`,
      description: c.description,
    })),
  ]

  // Determine if we should show the popover
  useEffect(() => {
    // Check if text starts with "/" and has no spaces (partial command)
    const trimmed = text.trimStart()
    if (trimmed.startsWith("/") && !trimmed.includes(" ")) {
      setOpen(true)
      setFilter(trimmed.toLowerCase())
      setSelectedIndex(0)
    } else {
      setOpen(false)
      setFilter("")
    }
  }, [text])

  const filtered = allCommands.filter((cmd) =>
    cmd.name.toLowerCase().startsWith(filter || "/")
  )

  const handleSelect = useCallback(
    (command: string) => {
      composerRuntime.setText(command + " ")
      setOpen(false)
      // Focus the textarea
      textareaRef.current?.focus()
    },
    [composerRuntime, textareaRef]
  )

  // Keyboard navigation
  useEffect(() => {
    if (!open) return

    const textarea = textareaRef.current
    if (!textarea) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!open) return

      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === "Tab" || (e.key === "Enter" && filtered.length > 0)) {
        // Only intercept Enter if the popover is showing commands
        if (filtered.length > 0 && e.key === "Tab") {
          e.preventDefault()
          handleSelect(filtered[selectedIndex]?.name ?? filtered[0]?.name ?? "")
        }
      } else if (e.key === "Escape") {
        setOpen(false)
      }
    }

    textarea.addEventListener("keydown", handleKeyDown)
    return () => textarea.removeEventListener("keydown", handleKeyDown)
  }, [open, filtered, selectedIndex, handleSelect, textareaRef])

  if (!open || filtered.length === 0) return null

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-0 mb-1 w-64 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover shadow-md z-10"
    >
      {filtered.map((cmd, i) => (
        <button
          key={cmd.name}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault() // Prevent blur on textarea
            handleSelect(cmd.name)
          }}
          className={cn(
            "w-full px-3 py-2 text-left text-sm transition-colors",
            "hover:bg-accent",
            i === selectedIndex && "bg-accent"
          )}
        >
          <span className="font-mono text-xs font-medium text-foreground">
            {cmd.name}
          </span>
          {cmd.description && (
            <span className="ml-2 text-xs text-muted-foreground">{cmd.description}</span>
          )}
        </button>
      ))}
    </div>
  )
}
