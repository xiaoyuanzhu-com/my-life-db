/**
 * ImageTool -- renderer for `generate_image` and `edit_image` MCP tool calls.
 *
 * Pulls the saved image's relative path out of the tool result and renders
 * it inline via the existing /raw/<path> static endpoint. Image bytes are
 * never inlined into the model context — only the path travels.
 */
import { useState, useRef } from "react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType, computeToolEffectiveStatus } from "../message-dot"

interface ImageArgs {
  prompt?: string
  imagePath?: string
  size?: string
  quality?: string
  background?: string
  filename?: string
  [key: string]: unknown
}

interface ImageInfo {
  relPath: string
  absPath?: string
  bytes?: number
  op: "generated" | "edited" | string
}

// Marker emitted by the backend on its own line at the end of the text
// content block: `[mylifedb-image] {"relPath":"...",...}`. The marker is the
// frontend-backend contract for image rendering — it survives whatever the
// agent CLI does to our MCP result, because text content always passes
// through. See backend/agentrunner/mcp.go:imageToolResult for the writer.
const MARKER_PREFIX = "[mylifedb-image] "
const MARKER_LINE = /^\[mylifedb-image\]\s+(\{.*\})\s*$/m

/**
 * Yield every text payload in the result tree. The agent CLI shape varies:
 *   Claude Code rawOutput: array of `{type:"text", text:"..."}`
 *   Spec-compliant MCP:    object with `content: [{type:"text", text:"..."}, ...]`
 *   Plain text rawOutput:  bare string
 * The recursion handles all three without per-shape branches.
 */
function* iterTextStrings(value: unknown, depth = 0): Generator<string> {
  if (depth > 6) return
  if (typeof value === "string") {
    yield value
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* iterTextStrings(item, depth + 1)
    return
  }
  if (value != null && typeof value === "object") {
    const r = value as Record<string, unknown>
    if (r.type === "text" && typeof r.text === "string") {
      yield r.text
      return
    }
    if (Array.isArray(r.content)) {
      for (const item of r.content) yield* iterTextStrings(item, depth + 1)
    }
  }
}

function infoFromObject(p: unknown): ImageInfo | null {
  if (p == null || typeof p !== "object") return null
  const r = p as Record<string, unknown>
  if (typeof r.relPath !== "string" || r.relPath === "") return null
  return {
    relPath: r.relPath,
    absPath: typeof r.absPath === "string" ? r.absPath : undefined,
    bytes: typeof r.bytes === "number" ? r.bytes : undefined,
    op: typeof r.op === "string" ? r.op : "generated",
  }
}

function extractImageInfo(result: unknown): ImageInfo | null {
  if (result == null) return null

  // 1. Result is the structured payload directly. Two cases:
  //    a. `{ structuredContent: {...}, content: [...] }` — spec-compliant
  //       MCP result object.
  //    b. The bare structured payload as an object — some CLIs unwrap it.
  if (typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>
    return (
      infoFromObject(r.structuredContent) ??
      infoFromObject(r) ??
      extractFromTextStrings(result)
    )
  }

  return extractFromTextStrings(result)
}

/**
 * Walk text strings and extract image info from each. Two contracts to try
 * per string:
 *   a. JSON-stringified structured payload — Claude Code's CLI emits this
 *      when `structuredContent` is set on the tool result (it replaces our
 *      text content with `JSON.stringify(structuredContent)` per the
 *      MCP 2025-06-18 backwards-compat recommendation).
 *   b. `[mylifedb-image] {json}` marker line — survives CLIs that don't
 *      rewrite our text (older Claude Code, other agent CLIs).
 */
function extractFromTextStrings(result: unknown): ImageInfo | null {
  for (const text of iterTextStrings(result)) {
    // (a) Bare JSON payload.
    const trimmed = text.trim()
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const info = infoFromObject(JSON.parse(trimmed))
        if (info) return info
      } catch { /* not JSON, fall through */ }
    }
    // (b) Marker line embedded in prose.
    if (text.includes(MARKER_PREFIX)) {
      const m = MARKER_LINE.exec(text)
      if (m) {
        try {
          const info = infoFromObject(JSON.parse(m[1]))
          if (info) return info
        } catch { /* fall through */ }
      }
    }
  }
  return null
}

function formatBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return ""
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

export function ImageToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<ImageArgs, unknown>) {
  const hasResult = result != null
  const effectiveStatus = computeToolEffectiveStatus(status, hasResult)
  const isComplete = effectiveStatus === "complete"
  const isRunning = effectiveStatus === "running"
  const isError = effectiveStatus === "incomplete"

  const [showDetails, setShowDetails] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)
  const failedSrcRef = useRef<string | null>(null)

  const op = toolName.toLowerCase().includes("edit") ? "Edit Image" : "Generate Image"
  const prompt = typeof args?.prompt === "string" ? args.prompt : ""

  const info = isComplete ? extractImageInfo(result) : null
  const src = info ? `/raw/${info.relPath.replace(/^\//, "")}` : null

  // Diagnostic: if the tool completed but the marker is missing, log the
  // result so we can see what the agent CLI delivered. The marker is OUR
  // contract — its absence is a backend/CLI bug, not a frontend bug.
  if (isComplete && !info && hasResult) {
    // eslint-disable-next-line no-console
    console.warn("[image-tool] [mylifedb-image] marker not found in result", { toolName, result })
  }

  // Reset error state if the src changes (e.g. another generation completes).
  if (src && failedSrcRef.current && failedSrcRef.current !== src) {
    failedSrcRef.current = null
    if (imgFailed) setImgFailed(false)
  }

  const dotType = toolStatusToDotType(effectiveStatus)

  const summary = (() => {
    if (isRunning) return "Generating..."
    if (isError) return "Error"
    if (isComplete && !info) return "Completed (no image path returned)"
    if (isComplete && info) {
      const sizeStr = formatBytes(info.bytes)
      return sizeStr ? `Saved ${info.relPath} (${sizeStr})` : `Saved ${info.relPath}`
    }
    return null
  })()

  const canExpand = !!prompt

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: dot + op (bold) + prompt (muted, truncated) + chevron */}
      <button
        type="button"
        onClick={() => canExpand && setShowDetails((s) => !s)}
        className={`flex items-start gap-2 w-full text-left ${canExpand ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
      >
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-semibold text-foreground shrink-0 whitespace-nowrap">{op}</span>
          {prompt && (
            <span className="text-muted-foreground truncate" title={prompt}>
              {prompt}
            </span>
          )}
          {canExpand && (
            <span className="text-[11px] shrink-0 text-muted-foreground/60">
              {showDetails ? "▾" : "▸"}
            </span>
          )}
        </div>
      </button>

      {/* Summary line */}
      {summary && (
        <div className={`flex gap-2 ml-5 ${isError ? "text-destructive" : "text-muted-foreground"}`}>
          <span className="select-none">{"└"}</span>
          <span>{summary}</span>
        </div>
      )}

      {/* Expanded: full prompt */}
      {showDetails && prompt && (
        <div className="ml-5 mt-2 p-2 rounded-md bg-muted/50 text-foreground whitespace-pre-wrap">
          {prompt}
        </div>
      )}

      {/* Inline image — always shown when available */}
      {src && !imgFailed && (
        <div className="ml-5 mt-2">
          <img
            src={src}
            alt={prompt || "generated image"}
            className="max-w-full max-h-[480px] rounded-md border border-border bg-muted/30"
            onError={() => {
              failedSrcRef.current = src
              setImgFailed(true)
            }}
          />
        </div>
      )}
      {src && imgFailed && (
        <div className="ml-5 mt-2 text-destructive">Image saved to disk but failed to load from {src}.</div>
      )}
    </div>
  )
}
