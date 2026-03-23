/**
 * ReadTool -- renderer for ACP ToolKind "read" (file reads)
 *
 * Matches the old Claude Code read-tool.tsx pattern:
 * - Header: MessageDot + "Read" (bold) + file path (muted)
 * - Summary line with tree connector showing line count
 * - NOT expandable (matching old behavior)
 * - Error with tree connector in destructive color
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
  const isComplete = status.type === "complete"
  const isRunning = status.type === "running"
  const isError = status.type === "requires-action"

  // Extract file path -- show filename only in header, full path on hover
  const filePath = args?.file_path || toolName || ""
  const fileName = filePath.split("/").pop() || filePath

  // Count lines from result
  const outputStr = result != null
    ? typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2)
    : null
  const lineCount = outputStr ? outputStr.split("\n").length : 0

  // Determine dot type
  const dotType = isError
    ? "tool-failed" as const
    : toolStatusToDotType(status.type)

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: dot + "Read" bold + file path */}
      <div className="flex items-start gap-2 w-full text-left">
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

      {/* Summary: line count */}
      {isComplete && lineCount > 0 && (
        <div className="flex gap-2 ml-5 text-muted-foreground">
          <span className="select-none">{"\u2514"}</span>
          <span>Read {lineCount} line{lineCount !== 1 ? "s" : ""}</span>
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
