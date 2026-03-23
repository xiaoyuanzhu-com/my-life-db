/**
 * PermissionCard -- rendered when a tool call has status "requires-action"
 *
 * Matches the old Claude Code permission-card.tsx pattern:
 * - Action verb in header: "Allow agent to {Run/Read/Write/Edit/Fetch/Search}?"
 * - Tool input shown in code-block bg (command, file path, URL)
 * - Keyboard shortcut hints on buttons (Enter, Esc)
 * - Slide animation on appear/dismiss
 */
import { useEffect, useRef, useState, useCallback } from "react"
import { useAgentContext } from "./agent-context"
import type { PermissionOption } from "~/hooks/use-agent-websocket"
import { cn } from "~/lib/utils"

interface PermissionCardProps {
  toolCallId: string
  toolName: string
  args: unknown
  options: PermissionOption[]
  /** Whether this is the first (topmost) permission card -- receives keyboard shortcuts */
  isFirst?: boolean
}

/** Get the action verb based on tool name */
function getActionVerb(toolName: string): string {
  const lower = toolName.toLowerCase()
  if (lower.includes("execute") || lower.includes("bash") || lower.includes("run")) return "Run"
  if (lower.includes("read")) return "Read"
  if (lower.includes("write")) return "Write"
  if (lower.includes("edit")) return "Edit"
  if (lower.includes("fetch")) return "Fetch"
  if (lower.includes("search") || lower.includes("grep") || lower.includes("glob")) return "Search"
  if (lower.includes("delete")) return "Delete"
  return "Use"
}

/** Get the preview text based on args */
function getPreviewText(toolName: string, args: unknown): string | null {
  if (args == null) return null
  if (typeof args === "string") return args

  const a = args as Record<string, unknown>

  // Try common field names
  if (typeof a.command === "string") return a.command
  if (typeof a.file_path === "string") return a.file_path
  if (typeof a.url === "string") return a.url
  if (typeof a.query === "string") return a.query
  if (typeof a.pattern === "string") return a.pattern
  if (typeof a.path === "string") return a.path

  // Fallback: JSON
  const json = JSON.stringify(args, null, 2)
  return json !== "{}" ? json : null
}

/** Determine button style by kind */
function buttonClass(kind: string): string {
  switch (kind) {
    case "allow":
    case "allow_once":
      return "bg-primary text-primary-foreground hover:bg-primary/90"
    case "allow_always":
    case "allow_session":
      return "border border-border text-foreground hover:bg-muted"
    case "reject":
    case "reject_once":
    case "deny":
      return "border border-border text-foreground hover:bg-muted"
    case "reject_always":
      return "border border-destructive/40 text-destructive hover:bg-destructive/10"
    default:
      return "border border-border text-foreground hover:bg-muted"
  }
}

export function PermissionCard({
  toolCallId,
  toolName,
  args,
  options,
  isFirst = false,
}: PermissionCardProps) {
  const { sendPermissionResponse } = useAgentContext()
  const cardRef = useRef<HTMLDivElement>(null)
  const [isDismissing, setIsDismissing] = useState(false)
  const [pendingOptionId, setPendingOptionId] = useState<string | null>(null)

  const actionVerb = getActionVerb(toolName)
  const previewText = getPreviewText(toolName, args)

  // Handle option click with dismiss animation
  const handleOption = useCallback(
    (optionId: string) => {
      if (isDismissing) return
      setIsDismissing(true)
      setPendingOptionId(optionId)
    },
    [isDismissing]
  )

  // After dismiss animation ends, send the actual response
  const handleAnimationEnd = () => {
    if (isDismissing && pendingOptionId) {
      sendPermissionResponse(toolCallId, pendingOptionId)
    }
  }

  // Keyboard shortcuts (only for the first card)
  useEffect(() => {
    if (!isFirst) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isDismissing) return
      const target = e.target as HTMLElement
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return
      }

      if (e.key === "Enter") {
        e.preventDefault()
        // Find allow_once or allow option
        const allowOption = options.find(
          (o) => o.kind === "allow_once" || o.kind === "allow"
        )
        if (allowOption) {
          handleOption(allowOption.optionId)
        }
      } else if (e.key === "Escape") {
        e.preventDefault()
        // Find reject_once or reject option
        const rejectOption = options.find(
          (o) => o.kind === "reject_once" || o.kind === "reject" || o.kind === "deny"
        )
        if (rejectOption) {
          handleOption(rejectOption.optionId)
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isFirst, isDismissing, options, handleOption])

  return (
    <div
      ref={cardRef}
      className={cn(
        "p-3 text-sm",
        isDismissing ? "animate-slide-down-fade" : "animate-permission-slide-up",
      )}
      onAnimationEnd={handleAnimationEnd}
    >
      {/* Header: "Allow agent to {Action}?" */}
      <div className="text-[14px] leading-relaxed text-foreground mb-2">
        Allow agent to <span className="font-semibold">{actionVerb}</span>?
      </div>

      {/* Tool input preview in code-block bg */}
      {previewText && (
        <div className="rounded-lg border border-border p-2 font-mono text-[12px] text-foreground overflow-x-hidden mb-3 max-h-24 md:max-h-32 overflow-y-auto bg-muted/50">
          <pre className="whitespace-pre-wrap break-all">{previewText}</pre>
        </div>
      )}

      {/* Permission option buttons with keyboard hints */}
      <div className="flex items-center justify-end gap-2 flex-wrap">
        {options.map((option) => {
          const isAllow = option.kind === "allow_once" || option.kind === "allow"
          const isReject = option.kind === "reject_once" || option.kind === "reject" || option.kind === "deny"

          return (
            <button
              key={option.optionId}
              type="button"
              onClick={() => handleOption(option.optionId)}
              disabled={isDismissing}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] transition-colors cursor-pointer disabled:opacity-50",
                buttonClass(option.kind),
              )}
            >
              {option.name}
              {/* Keyboard hint for first card */}
              {isFirst && isAllow && (
                <kbd className="hidden md:inline px-1 py-0.5 rounded bg-primary-foreground/20 text-primary-foreground text-[10px] font-mono">
                  {"\u23CE"}
                </kbd>
              )}
              {isFirst && isReject && (
                <kbd className="hidden md:inline px-1 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-mono">
                  Esc
                </kbd>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
