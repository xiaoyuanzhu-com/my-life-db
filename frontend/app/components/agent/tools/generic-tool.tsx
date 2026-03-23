/**
 * GenericTool — fallback renderer for ACP ToolKinds:
 * search, fetch, think, delete, move, other
 *
 * Shows title + kind badge, raw input as collapsed JSON, raw output as
 * collapsed JSON when available.
 */
import { useState } from "react"
import { ChevronRight, Wrench } from "lucide-react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { cn } from "~/lib/utils"
import { MessageDot, toolStatusToDotType } from "../message-dot"

interface GenericArgs {
  kind?: string
  [key: string]: unknown
}

// Derive a human-readable kind label from args or toolName
function inferKind(toolName: string, args: GenericArgs): string {
  if (args.kind && typeof args.kind === "string") return args.kind
  // Attempt to infer from the title prefix (e.g. "Search foo" -> "search")
  const lower = toolName.toLowerCase()
  for (const k of ["search", "fetch", "think", "delete", "move", "read", "edit", "execute"]) {
    if (lower.startsWith(k)) return k
  }
  return "tool"
}

// Kind -> icon color
function kindColor(kind: string): string {
  switch (kind) {
    case "search": return "text-blue-500"
    case "fetch": return "text-violet-500"
    case "think": return "text-amber-500"
    case "delete": return "text-destructive"
    case "move": return "text-sky-500"
    default: return "text-muted-foreground"
  }
}

export function GenericToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<GenericArgs, unknown>) {
  const isComplete = status.type === "complete"
  const isRunning = status.type === "running"
  const isError = status.type === "requires-action"
  const kind = inferKind(toolName, args)

  const [openInput, setOpenInput] = useState(false)
  const [openOutput, setOpenOutput] = useState(false)

  const hasArgs = args && Object.keys(args).length > 0
  const inputStr = hasArgs ? JSON.stringify(args, null, 2) : null
  const outputStr = result != null
    ? typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2)
    : null

  const summaryText = isError
    ? "Error"
    : isComplete
      ? "Done"
      : isRunning
        ? "Running..."
        : "Pending"

  return (
    <div className="my-1 rounded-md border border-border bg-muted/30 text-sm">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <MessageDot type={isError ? "tool-failed" : toolStatusToDotType(status.type)} />
        <Wrench className={cn("h-3.5 w-3.5 shrink-0", kindColor(kind))} />
        <span className="flex-1 truncate font-mono text-xs text-foreground">
          {toolName}
        </span>
        <span className={cn(
          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
          "bg-muted text-muted-foreground"
        )}>
          {kind}
        </span>
      </div>

      {/* Summary line */}
      <div className="flex items-center gap-1 px-3 pb-1.5 text-[11px] text-muted-foreground">
        <span className="text-muted-foreground/60">{'\u2514'}</span>
        <span className={isError ? "text-destructive" : ""}>{summaryText}</span>
      </div>

      {/* Raw Input (collapsed by default) */}
      {inputStr && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setOpenInput((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-muted/50 transition-colors text-[11px] text-muted-foreground"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 transition-transform",
                openInput && "rotate-90"
              )}
            />
            input
          </button>
          {openInput && (
            <div className="px-3 pb-2">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed max-h-48 text-foreground">
                {inputStr}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Raw Output (collapsed by default) */}
      {outputStr && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setOpenOutput((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-muted/50 transition-colors text-[11px] text-muted-foreground"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 transition-transform",
                openOutput && "rotate-90"
              )}
            />
            output
          </button>
          {openOutput && (
            <div className="px-3 pb-2">
              <pre className={cn(
                "overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed max-h-48",
                isError ? "text-destructive" : "text-foreground"
              )}>
                {outputStr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
