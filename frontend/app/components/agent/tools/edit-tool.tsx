/**
 * EditTool -- renderer for ACP ToolKind "edit" (file edits / diffs)
 *
 * Diff source priority:
 *   1. args.old_string / new_string (initial tool_call frame, raw input)
 *   2. result.toolResponse.oldString / newString (full strings, may be stripped)
 *   3. result.content[*] DiffResult (oldText / newText, may be stripped)
 *   4. result.toolResponse.structuredPatch (always preserved — unified diff hunks)
 *
 * The fourth path is the fallback after the heavy strings have been stripped
 * by the backend (see frame_strip.go). structuredPatch is bounded by edit
 * size and contains the diff hunks Claude Code already computed.
 */
import { useState } from "react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType, computeToolEffectiveStatus } from "../message-dot"

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

interface StructuredPatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

interface EditResult {
  filePath?: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
  structuredPatch?: StructuredPatchHunk[]
  userModified?: boolean
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
    (typeof (v as EditResult).oldString === "string" ||
      typeof (v as EditResult).newString === "string" ||
      Array.isArray((v as EditResult).structuredPatch))
  )
}

type DiffLine = { kind: "del" | "add" | "ctx"; text: string }

function linesFromOldNew(oldStr: string, newStr: string): DiffLine[] {
  const out: DiffLine[] = []
  if (oldStr) for (const l of oldStr.split("\n")) out.push({ kind: "del", text: l })
  if (newStr) for (const l of newStr.split("\n")) out.push({ kind: "add", text: l })
  return out
}

function linesFromHunks(hunks: StructuredPatchHunk[]): DiffLine[] {
  const out: DiffLine[] = []
  for (const h of hunks) {
    for (const l of h.lines ?? []) {
      const first = l[0] ?? " "
      const rest = l.slice(1)
      if (first === "-") out.push({ kind: "del", text: rest })
      else if (first === "+") out.push({ kind: "add", text: rest })
      else out.push({ kind: "ctx", text: rest })
    }
  }
  return out
}

const MAX_LINES = 10

export function EditToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<EditArgs, unknown>) {
  const hasResult = result != null
  const effectiveStatus = computeToolEffectiveStatus(status, hasResult)
  const isRunning = effectiveStatus === "running"
  const isError = effectiveStatus === "incomplete"
  const [expanded, setExpanded] = useState(false)

  const editResult = isEditResult(result) ? result : null
  const hasDiffResult = isDiffResult(result)

  const filePath = args?.file_path || editResult?.filePath || (() => {
    const match = toolName.match(/^(?:Edit|Write)\s+(.+)$/i)
    return match ? match[1].trim() : toolName
  })() || ""
  const fileName = filePath.split("/").pop() || filePath
  const replaceAll = args?.replace_all ?? editResult?.replaceAll ?? false

  const dotType = toolStatusToDotType(effectiveStatus)

  const oldStr = args?.old_string ?? editResult?.oldString ?? (hasDiffResult ? (result as DiffResult).oldText : undefined) ?? ""
  const newStr = args?.new_string ?? editResult?.newString ?? (hasDiffResult ? (result as DiffResult).newText : undefined) ?? ""

  let diffLines: DiffLine[] = linesFromOldNew(oldStr, newStr)
  if (diffLines.length === 0 && editResult?.structuredPatch?.length) {
    diffLines = linesFromHunks(editResult.structuredPatch)
  }

  const hasDiff = diffLines.length > 0
  const isTruncated = diffLines.length > MAX_LINES
  const displayLines = expanded ? diffLines : diffLines.slice(0, MAX_LINES)

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      <div className="flex items-start gap-2">
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-foreground">Edit</span>
          <span className="ml-2 text-muted-foreground break-all" title={filePath}>
            {fileName}
          </span>
          {replaceAll && (
            <span className="ml-2 text-muted-foreground/70">(replace all)</span>
          )}
        </div>
      </div>

      {hasDiff && (
        <div className="mt-3 rounded-md overflow-hidden border border-border">
          <div
            className={expanded && isTruncated ? "overflow-y-auto" : ""}
            style={expanded && isTruncated ? { maxHeight: "60vh" } : {}}
          >
            {displayLines.map((line, i) => {
              if (line.kind === "del") {
                return (
                  <div
                    key={`l-${i}`}
                    className="font-mono text-[13px] leading-[1.5] flex bg-destructive/10"
                  >
                    <span className="inline-block px-3 select-none text-destructive/70">-</span>
                    <span className="flex-1 pr-3 whitespace-pre-wrap break-all text-destructive">{line.text}</span>
                  </div>
                )
              }
              if (line.kind === "add") {
                return (
                  <div
                    key={`l-${i}`}
                    className="font-mono text-[13px] leading-[1.5] flex bg-emerald-500/10"
                  >
                    <span className="inline-block px-3 select-none text-emerald-600 dark:text-emerald-400">+</span>
                    <span className="flex-1 pr-3 whitespace-pre-wrap break-all text-emerald-700 dark:text-emerald-300">{line.text}</span>
                  </div>
                )
              }
              return (
                <div
                  key={`l-${i}`}
                  className="font-mono text-[13px] leading-[1.5] flex"
                >
                  <span className="inline-block px-3 select-none text-muted-foreground/50"> </span>
                  <span className="flex-1 pr-3 whitespace-pre-wrap break-all text-muted-foreground">{line.text}</span>
                </div>
              )
            })}
          </div>

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

      {isRunning && !hasDiff && (
        <div className="flex gap-2 ml-5 text-muted-foreground">
          <span className="select-none">{"└"}</span>
          <span>Editing...</span>
        </div>
      )}

      {isError && (
        <div className="font-mono text-[13px] mt-2 text-destructive">
          Error
        </div>
      )}
    </div>
  )
}
