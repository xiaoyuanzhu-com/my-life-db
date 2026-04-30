/**
 * PlanView -- renders ACP plan entries as a checklist.
 *
 * Matches the old Claude Code todo-tool.tsx pattern:
 * - Tree connectors for items
 * - Checkbox icons: empty circle (pending), half-filled (in_progress), checkmark (completed)
 * - Completed items: strikethrough + muted
 * - Proper font-mono styling matching the rest of the UI
 */
import { cn } from "~/lib/utils"
import { MessageDot } from "./message-dot"
import type { PlanEntry } from "~/hooks/use-agent-runtime"

interface PlanViewProps {
  entries: PlanEntry[]
  className?: string
}

function StatusIcon({ status }: { status: PlanEntry["status"] }) {
  switch (status) {
    case "completed":
      return (
        <svg className="h-3.5 w-3.5 shrink-0 text-emerald-500" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity="0.1" />
          <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case "in_progress":
      return (
        <svg className="h-3.5 w-3.5 shrink-0 text-blue-500 animate-pulse" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 1a7 7 0 0 1 0 14" fill="currentColor" fillOpacity="0.15" />
        </svg>
      )
    case "pending":
    default:
      return (
        <svg className="h-3.5 w-3.5 shrink-0 text-muted-foreground" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )
  }
}

export function PlanView({ entries, className }: PlanViewProps) {
  if (entries.length === 0) return null

  const priorities = entries.map(e => e.priority).filter(Boolean)
  const showPriority = priorities.length > 0 && new Set(priorities).size > 1

  return (
    <div className={cn("font-mono text-[13px] leading-[1.5]", className)}>
      {/* Header */}
      <div className="flex items-start gap-2 mb-2">
        <MessageDot type="system" />
        <span className="font-semibold text-foreground">Tasks</span>
      </div>

      {/* Plan items with tree connectors */}
      <div className="ml-5 space-y-1">
        {entries.map((entry, index) => {
          const isLast = index === entries.length - 1
          const connector = isLast ? "\u2514" : "\u251C"

          return (
            <div key={entry.id} className="flex items-start gap-2">
              <span className="select-none text-muted-foreground/60 w-3 text-center shrink-0">
                {connector}
              </span>
              <div className="mt-0.5 shrink-0">
                <StatusIcon status={entry.status} />
              </div>
              <span
                className={cn(
                  "flex-1 text-[13px]",
                  entry.status === "completed"
                    ? "line-through text-muted-foreground"
                    : entry.status === "in_progress"
                      ? "text-foreground"
                      : "text-muted-foreground"
                )}
              >
                {entry.content}
              </span>
              {showPriority && entry.priority && (
                <span className={cn(
                  "shrink-0 rounded px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                  entry.priority === "high" || entry.priority === "p0"
                    ? "bg-destructive/10 text-destructive"
                    : entry.priority === "medium" || entry.priority === "p1"
                      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      : "bg-muted text-muted-foreground"
                )}>
                  {entry.priority}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
