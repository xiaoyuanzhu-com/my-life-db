/**
 * Tool dispatch — maps ACP tool names to kind-specific renderers.
 *
 * Extracted from agent-chat.tsx so it can be reused by the generated
 * Thread component and any other consumer that needs tool rendering.
 */
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { ExecuteToolRenderer } from "./tools/execute-tool"
import { ReadToolRenderer } from "./tools/read-tool"
import { EditToolRenderer } from "./tools/edit-tool"
import { SearchToolRenderer } from "./tools/search-tool"
import { FetchToolRenderer } from "./tools/fetch-tool"
import { ToolFallback } from "~/components/assistant-ui/tool-fallback"

/**
 * Infer ACP ToolKind from the tool name and args.
 * toolName is the ACP title, e.g., "Read /src/main.go".
 */
export function inferToolKind(toolName: string, args: Record<string, unknown>): string {
  // Use explicit kind from ACP if present and recognized
  if (typeof args.kind === "string" && args.kind !== "other" && args.kind !== "") return args.kind

  const lower = toolName.toLowerCase()

  // Read tools
  if (lower.startsWith("read ") || lower === "read") return "read"

  // Edit/Write tools
  if (
    lower.startsWith("edit ") ||
    lower === "edit" ||
    lower.startsWith("write ") ||
    lower === "write"
  ) return "edit"

  // Execute/Bash tools
  if (
    lower.startsWith("execute ") ||
    lower.startsWith("bash ") ||
    lower.startsWith("run ") ||
    lower === "execute"
  ) return "execute"

  // Search tools -- includes Grep, Glob, WebSearch, ToolSearch
  if (
    lower.startsWith("search") ||
    lower === "search" ||
    lower.startsWith("grep ") ||
    lower === "grep" ||
    lower.startsWith("glob ") ||
    lower === "glob" ||
    lower.startsWith("websearch ") ||
    lower === "websearch" ||
    lower === "toolsearch"
  ) return "search"

  // Fetch tools -- includes WebFetch
  if (
    lower.startsWith("fetch") ||
    lower === "fetch" ||
    lower.startsWith("webfetch ") ||
    lower === "webfetch"
  ) return "fetch"

  // Think tool
  if (lower.startsWith("think") || lower === "think") return "think"

  // Delete tool
  if (lower.startsWith("delete") || lower === "delete") return "delete"

  // Move tool
  if (lower.startsWith("move") || lower === "move") return "move"

  // Agent/Task/TodoWrite -- intentionally "other" (use generic renderer)
  return "other"
}

/** Single Override renderer that dispatches to kind-specific components */
export function AcpToolRenderer(props: ToolCallMessagePartProps) {
  const kind = inferToolKind(
    props.toolName,
    (props.args ?? {}) as Record<string, unknown>
  )

  switch (kind) {
    case "execute":
      return <ExecuteToolRenderer {...props} />
    case "read":
      return <ReadToolRenderer {...props} />
    case "edit":
      return <EditToolRenderer {...props} />
    case "search":
      return <SearchToolRenderer {...props} />
    case "fetch":
      return <FetchToolRenderer {...props} />
    // TODO: restore tree connector symbols (└─ ├─) for visual hierarchy
    // TODO: restore tool kind label with title-cased name
    default:
      return <ToolFallback {...props} />
  }
}

/** Tools config object for assistant-ui message rendering */
export const acpToolsConfig = {
  Override: AcpToolRenderer,
} as const
