/**
 * EditTool -- renderer for ACP ToolKind "edit" (file edits / diffs)
 *
 * Matches the old Claude Code edit-tool.tsx pattern:
 * - Header: MessageDot + "Edit" (bold) + file path (muted) + optional "(replace all)"
 * - Unified diff: deleted lines red bg with "-", added lines green bg with "+"
 * - Truncated to 5+5 lines with "Show more/less" toggle
 * - Error below diff in destructive color
 */
import { useState } from "react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType } from "../message-dot"

interface EditArgs {
  kind?: string
  file_path?: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
  [key: string]: unknown
}

interface DiffResult {
  type: "diff"
  oldText?: string
  newText?: string
}

/** Result structure from Claude Code Edit tool.
 * originalFile is stripped by backend (StripHeavyToolCallContent). */
interface EditResult {
  filePath?: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
  structuredPatch?: StructuredPatchHunk[]
  userModified?: boolean
}

interface StructuredPatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

function isDiffResult(v: unknown): v is DiffResult {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { type?: string }).type === "diff"
  )
}

function isEditResult(v: unknown): v is EditResult {
  return (
    typeof v === "object" &&
    v !== null &&
    (typeof (v as EditResult).oldString === "string" || typeof (v as EditResult).newString === "string" || Array.isArray((v as EditResult).structuredPatch))
  )
}

const MAX_OLD_LINES = 5
const MAX_NEW_LINES = 5

export function EditToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<EditArgs, unknown>) {
  // If no result yet and status is "incomplete" (e.g. history replay), treat as still working
  const hasResult = result != null
  const effectiveStatus = (status.type === "incomplete" && !hasResult) || status.type === "requires-action" ? "running" : status.type
  const isComplete = effectiveStatus === "complete"
  const isRunning = effectiveStatus === "running"
  const isError = effectiveStatus === "incomplete"
  const [expanded, setExpanded] = useState(false)

  // Parse result structure
  const editResult = isEditResult(result) ? result : null
  const hasDiffResult = isDiffResult(result)

  // Extract file path from args, result, or toolName
  const filePath = args?.file_path || editResult?.filePath || (() => {
    const match = toolName.match(/^(?:Edit|Write)\s+(.+)$/i)
    return match ? match[1].trim() : toolName
  })() || ""
  const fileName = filePath.split("/").pop() || filePath
  const replaceAll = args?.replace_all ?? editResult?.replaceAll ?? false

  // Determine dot type
  const dotType = isError
    ? "tool-failed" as const
    : toolStatusToDotType(effectiveStatus)

  // Get diff lines from args (snake_case), result (camelCase), or DiffResult
  const oldStr = args?.old_string ?? editResult?.oldString ?? (hasDiffResult ? (result as DiffResult).oldText : undefined) ?? ""
  const newStr = args?.new_string ?? editResult?.newString ?? (hasDiffResult ? (result as DiffResult).newText : undefined) ?? ""

  const oldLines = oldStr ? oldStr.split("\n") : []
  const newLines = newStr ? newStr.split("\n") : []
  const hasDiff = oldLines.length > 0 || newLines.length > 0

  // Truncation
  const isTruncated = oldLines.length > MAX_OLD_LINES || newLines.length > MAX_NEW_LINES
  const displayOldLines = expanded ? oldLines : oldLines.slice(0, MAX_OLD_LINES)
  const displayNewLines = expanded ? newLines : newLines.slice(0, MAX_NEW_LINES)

  // Fallback output for non-diff results
  const outputStr = !hasDiff && !hasDiffResult && !editResult && result != null
    ? typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2)
    : null

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: dot + "Edit" bold + file path */}
      <div className="flex items-start gap-2 mb-3">
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-foreground">
            Edit
          </span>
          <span className="ml-2 text-muted-foreground break-all" title={filePath}>
            {fileName}
          </span>
          {replaceAll && (
            <span className="ml-2 text-muted-foreground/70">(replace all)</span>
          )}
        </div>
      </div>

      {/* Unified diff view */}
      {hasDiff && (
        <div className="rounded-md overflow-hidden border border-border">
          <div
            className={expanded && isTruncated ? "overflow-y-auto" : ""}
            style={expanded && isTruncated ? { maxHeight: "60vh" } : {}}
          >
            {/* Deleted lines */}
            {displayOldLines.map((line, i) => (
              <div
                key={`del-${i}`}
                className="font-mono text-[13px] leading-[1.5] flex bg-destructive/10"
              >
                <span className="inline-block px-3 select-none text-destructive/70">-</span>
                <span className="flex-1 pr-3 whitespace-pre-wrap break-all text-destructive">{line}</span>
              </div>
            ))}

            {/* Added lines */}
            {displayNewLines.map((line, i) => (
              <div
                key={`add-${i}`}
                className="font-mono text-[13px] leading-[1.5] flex bg-emerald-500/10"
              >
                <span className="inline-block px-3 select-none text-emerald-600 dark:text-emerald-400">+</span>
                <span className="flex-1 pr-3 whitespace-pre-wrap break-all text-emerald-700 dark:text-emerald-300">{line}</span>
              </div>
            ))}
          </div>

          {/* Expand/Collapse button */}
          {isTruncated && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="w-full py-1.5 text-[12px] cursor-pointer hover:opacity-80 transition-opacity bg-muted/50 text-muted-foreground border-t border-border"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      {/* Raw output fallback (non-diff result) */}
      {outputStr && (
        <div className="mt-2 ml-5 p-3 rounded-md bg-muted/50 overflow-y-auto whitespace-pre-wrap break-all text-muted-foreground" style={{ maxHeight: "60vh" }}>
          {outputStr}
        </div>
      )}

      {/* Running state */}
      {isRunning && !hasDiff && !outputStr && (
        <div className="flex gap-2 ml-5 text-muted-foreground">
          <span className="select-none">{"\u2514"}</span>
          <span>Editing...</span>
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="font-mono text-[13px] mt-2 text-destructive">
          Error
        </div>
      )}
    </div>
  )
}
