/**
 * EditTool — renderer for ACP ToolKind "edit" (file edits / diffs)
 *
 * Shows the file path from title. If the result has type "diff", renders
 * oldText/newText side by side. Otherwise renders rawOutput. Collapsible.
 */
import { useState } from "react"
import { ChevronRight, Pencil } from "lucide-react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { cn } from "~/lib/utils"

interface EditArgs {
  kind?: string
  [key: string]: unknown
}

interface DiffResult {
  type: "diff"
  oldText?: string
  newText?: string
}

function isDiffResult(v: unknown): v is DiffResult {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { type?: string }).type === "diff"
  )
}

export function EditToolRenderer({
  toolName,
  result,
  status,
}: ToolCallMessagePartProps<EditArgs, unknown>) {
  const isComplete = status.type === "complete"
  const isRunning = status.type === "running"

  // Default: collapsed when complete, expanded when running/pending
  const [open, setOpen] = useState(!isComplete)

  const hasDiff = isDiffResult(result)
  const outputStr = !hasDiff && result != null
    ? typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2)
    : null

  return (
    <div className="my-1 rounded-md border border-border bg-muted/30 text-sm">
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-md"
      >
        <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate font-mono text-xs text-foreground">
          {toolName}
        </span>
        {isRunning && (
          <span className="text-[10px] text-amber-500 animate-pulse">editing</span>
        )}
        {isComplete && (
          <span className="text-[10px] text-muted-foreground">done</span>
        )}
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
      </button>

      {/* Diff view */}
      {open && hasDiff && (
        <div className="border-t border-border">
          {(result as DiffResult).oldText != null && (
            <div className="border-b border-border px-3 py-2 bg-destructive/5">
              <div className="mb-1 text-[10px] font-medium text-destructive/70 uppercase tracking-wide">
                removed
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed max-h-48 text-destructive">
                {(result as DiffResult).oldText}
              </pre>
            </div>
          )}
          {(result as DiffResult).newText != null && (
            <div className="px-3 py-2 bg-emerald-500/5">
              <div className="mb-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">
                added
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed max-h-48 text-emerald-700 dark:text-emerald-300">
                {(result as DiffResult).newText}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Raw output fallback */}
      {open && !hasDiff && outputStr != null && (
        <div className="border-t border-border px-3 py-2">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed max-h-64 text-foreground">
            {outputStr}
          </pre>
        </div>
      )}

      {open && isRunning && result == null && (
        <div className="border-t border-border px-3 py-2">
          <span className="font-mono text-[11px] text-muted-foreground animate-pulse">
            …
          </span>
        </div>
      )}
    </div>
  )
}
