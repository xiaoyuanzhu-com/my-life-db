/**
 * PlanView — renders ACP plan entries as a checklist.
 *
 * Each entry shows a status icon (pending/in_progress/completed),
 * content text, and optional priority badge. Completed items
 * have strikethrough and muted color.
 */
import { cn } from "~/lib/utils"
import type { PlanEntry } from "~/hooks/use-agent-runtime"

interface PlanViewProps {
  entries: PlanEntry[]
  className?: string
}

function StatusIcon({ status }: { status: PlanEntry["status"] }) {
  switch (status) {
    case "completed":
      return (
        <svg className="h-4 w-4 shrink-0 text-emerald-500" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity="0.1" />
          <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case "in_progress":
      return (
        <svg className="h-4 w-4 shrink-0 text-blue-500 animate-pulse" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 1a7 7 0 0 1 0 14" fill="currentColor" fillOpacity="0.15" />
        </svg>
      )
    case "pending":
    default:
      return (
        <svg className="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )
  }
}

function PriorityBadge({ priority }: { priority: string }) {
  const colorClass =
    priority === "high" || priority === "p0"
      ? "bg-destructive/10 text-destructive border-destructive/30"
      : priority === "medium" || priority === "p1"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
        : "bg-muted text-muted-foreground border-border"

  return (
    <span className={cn(
      "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide border",
      colorClass
    )}>
      {priority}
    </span>
  )
}

export function PlanView({ entries, className }: PlanViewProps) {
  if (entries.length === 0) return null

  return (
    <div className={cn("px-4 py-2", className)}>
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
          Plan
        </div>
        <ul className="space-y-1.5">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-2">
              <div className="mt-0.5">
                <StatusIcon status={entry.status} />
              </div>
              <span
                className={cn(
                  "flex-1 text-sm",
                  entry.status === "completed"
                    ? "line-through text-muted-foreground"
                    : "text-foreground"
                )}
              >
                {entry.content}
              </span>
              {entry.priority && <PriorityBadge priority={entry.priority} />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
