/**
 * ReadTool -- renderer for ACP ToolKind "read" (file reads)
 *
 * - Header: MessageDot + "Read" (bold) + file path (muted)
 * - Summary line with tree connector showing line count
 * - Error with tree connector in destructive color
 *
 * File content is stripped by the backend (StripHeavyToolCallContent) to reduce
 * WebSocket payload size. Only metadata (numLines, startLine, totalLines) is
 * preserved for the summary.
 */
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType } from "../message-dot"

interface ReadArgs {
  kind?: string
  file_path?: string
  [key: string]: unknown
}

export function ReadToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<ReadArgs, unknown>) {
  // If no result yet and status is "incomplete" (e.g. history replay), treat as still working
  const hasResult = result != null
  const effectiveStatus = (status.type === "incomplete" && !hasResult) || status.type === "requires-action" ? "running" : status.type
  const isComplete = effectiveStatus === "complete"
  const isRunning = effectiveStatus === "running"
  const isError = effectiveStatus === "incomplete"

  // Extract file path -- show filename only in header, full path on hover
  // The ACP title is e.g., "Read /src/main.go", so extract the path from it
  const filePath = args?.file_path || (() => {
    const match = toolName.match(/^Read\s+(.+)$/i)
    return match ? match[1].trim() : toolName
  })() || ""
  const fileName = filePath.split("/").pop() || filePath

  // Extract metadata from structured result
  const fileResult = result != null && typeof result === "object" && !Array.isArray(result)
    ? result as { type?: string; file?: { numLines?: number; startLine?: number; totalLines?: number }; text?: string }
    : null
  const lineCount = fileResult?.file?.numLines ?? 0
  const startLine = fileResult?.file?.startLine
  const totalLines = fileResult?.file?.totalLines

  // Determine dot type
  const dotType = isError
    ? "tool-failed" as const
    : toolStatusToDotType(effectiveStatus)

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: dot + "Read" bold + file path */}
      <div className="flex items-start gap-2">
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-foreground">
            Read
          </span>
          <span className="ml-2 text-muted-foreground truncate" title={filePath}>
            {fileName}
          </span>
        </div>
      </div>

      {/* Summary: line count + optional range */}
      {isComplete && lineCount > 0 && (
        <div className="flex gap-2 ml-5 text-muted-foreground">
          <span className="select-none">{"\u2514"}</span>
          <span>
            Read {lineCount} line{lineCount !== 1 ? "s" : ""}
            {startLine != null && totalLines != null && (
              <span className="text-muted-foreground/60"> ({startLine}&ndash;{startLine + lineCount - 1} of {totalLines})</span>
            )}
          </span>
        </div>
      )}

      {/* Running state */}
      {isRunning && (
        <div className="flex gap-2 ml-5 text-muted-foreground">
          <span className="select-none">{"\u2514"}</span>
          <span>Reading...</span>
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="flex gap-2 ml-5 text-destructive">
          <span className="select-none">{"\u2514"}</span>
          <span>Error</span>
        </div>
      )}
    </div>
  )
}
