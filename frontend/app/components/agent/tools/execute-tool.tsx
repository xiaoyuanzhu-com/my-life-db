/**
 * ExecuteTool — renderer for ACP ToolKind "execute" (shell commands)
 *
 * Shows the command being run and its output in a collapsible pre/code block.
 * Collapses by default when the tool call is complete.
 */
import { useState } from "react"
import { ChevronRight, Terminal } from "lucide-react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { cn } from "~/lib/utils"
import { MessageDot, toolStatusToDotType } from "../message-dot"

// ACP rawInput shape for execute tools
interface ExecuteArgs {
  kind?: string
  [key: string]: unknown
}

export function ExecuteToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<ExecuteArgs, unknown>) {
  const isComplete = status.type === "complete"
  const isRunning = status.type === "running"
  const isError = status.type === "requires-action" || (result !== undefined && (args as { isError?: boolean }).isError)

  // Default: collapsed when complete, expanded when running/pending
  const [open, setOpen] = useState(!isComplete)

  const outputStr = result != null
    ? typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2)
    : null

  // Build summary line
  const summaryText = isError
    ? "Error"
    : isComplete
      ? "Completed"
      : isRunning
        ? "Running..."
        : "Pending"

  return (
    <div className="my-1 rounded-md border border-border bg-muted/30 text-sm">
      {/* Header — clickable to collapse/expand */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-md"
      >
        <MessageDot type={isError ? "tool-failed" : toolStatusToDotType(status.type)} />
        <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate font-mono text-xs text-foreground">
          {toolName}
        </span>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
      </button>

      {/* Summary line */}
      <div className="flex items-center gap-1 px-3 pb-1.5 text-[11px] text-muted-foreground">
        <span className="text-muted-foreground/60">{'\u2514'}</span>
        <span className={isError ? "text-destructive" : ""}>{summaryText}</span>
      </div>

      {/* Output */}
      {open && outputStr != null && (
        <div className="border-t border-border px-3 py-2">
          <pre
            className={cn(
              "overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed max-h-64",
              isError ? "text-destructive" : "text-foreground"
            )}
          >
            {outputStr}
          </pre>
        </div>
      )}

      {/* Running indicator when no output yet */}
      {open && isRunning && outputStr == null && (
        <div className="border-t border-border px-3 py-2">
          <span className="font-mono text-[11px] text-muted-foreground animate-pulse">
            ...
          </span>
        </div>
      )}
    </div>
  )
}
