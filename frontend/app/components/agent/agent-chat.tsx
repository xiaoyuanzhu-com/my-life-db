/**
 * AgentChat — Top-level chat component backed by the ACP WebSocket runtime.
 *
 * Uses assistant-ui's AssistantRuntimeProvider + ThreadPrimitive + MessagePrimitive
 * to render the conversation. Tool calls are dispatched to kind-specific renderers.
 * Permission cards appear below the thread for tool calls awaiting approval.
 */
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react"
import { Send, Square, ArrowDown, Folder, Terminal } from "lucide-react"
import { cn } from "~/lib/utils"
import { useAgentRuntime } from "~/hooks/use-agent-runtime"
import { AgentContextProvider, useAgentContext } from "./agent-context"
import { PermissionCard } from "./permission-card"
import { ExecuteToolRenderer } from "./tools/execute-tool"
import { ReadToolRenderer } from "./tools/read-tool"
import { EditToolRenderer } from "./tools/edit-tool"
import { GenericToolRenderer } from "./tools/generic-tool"
import { PermissionModeSelector, type PermissionMode } from "~/components/claude/chat/permission-mode-selector"

// ── Tool dispatch ──────────────────────────────────────────────────────────

/**
 * Infer ACP ToolKind from the tool name and args.
 * toolName is the ACP title, e.g., "Read /src/main.go".
 */
function inferToolKind(toolName: string, args: Record<string, unknown>): string {
  if (typeof args.kind === "string") return args.kind

  const lower = toolName.toLowerCase()
  if (lower.startsWith("read ") || lower === "read") return "read"
  if (
    lower.startsWith("edit ") ||
    lower === "edit" ||
    lower.startsWith("write ") ||
    lower === "write"
  ) return "edit"
  if (
    lower.startsWith("execute ") ||
    lower.startsWith("bash ") ||
    lower.startsWith("run ") ||
    lower === "execute"
  ) return "execute"
  if (lower.startsWith("search") || lower === "search") return "search"
  if (lower.startsWith("fetch") || lower === "fetch") return "fetch"
  if (lower.startsWith("think") || lower === "think") return "think"
  if (lower.startsWith("delete") || lower === "delete") return "delete"
  if (lower.startsWith("move") || lower === "move") return "move"
  return "other"
}

/** Single Override renderer that dispatches to kind-specific components */
function AcpToolRenderer(props: ToolCallMessagePartProps) {
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
    default:
      return <GenericToolRenderer {...props} />
  }
}

// ── Message components ─────────────────────────────────────────────────────

const toolsConfig = {
  Override: AcpToolRenderer,
} as const

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end mb-4">
      <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2.5">
        <MessagePrimitive.Parts
          components={{
            Text: ({ text }) => (
              <p className="text-sm text-primary-foreground whitespace-pre-wrap break-words">
                {text}
              </p>
            ),
            tools: toolsConfig,
          }}
        />
      </div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start mb-4">
      <div className="max-w-[85%] min-w-0">
        <MessagePrimitive.Parts
          components={{
            Text: ({ text }) => (
              <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                {text}
              </p>
            ),
            Reasoning: ({ text }) => (
              <details className="my-1">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors">
                  Reasoning
                </summary>
                <p className="mt-1 pl-2 text-xs text-muted-foreground whitespace-pre-wrap break-words border-l border-border">
                  {text}
                </p>
              </details>
            ),
            tools: toolsConfig,
          }}
        />
      </div>
    </MessagePrimitive.Root>
  )
}

// ── Pending permissions ────────────────────────────────────────────────────

function PendingPermissions() {
  const { pendingPermissions } = useAgentContext()

  if (pendingPermissions.size === 0) return null

  return (
    <div className="space-y-2 mt-2 mb-2">
      {Array.from(pendingPermissions.entries()).map(([toolCallId, entry]) => (
        <PermissionCard
          key={toolCallId}
          toolCallId={toolCallId}
          toolName={entry.toolName}
          args={null}
          options={entry.options}
        />
      ))}
    </div>
  )
}

// ── Composer ───────────────────────────────────────────────────────────────

function AgentComposer() {
  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <ComposerPrimitive.Root className="flex items-end gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
        <ComposerPrimitive.Input
          placeholder="Message…"
          className={cn(
            "flex-1 resize-none bg-transparent text-sm text-foreground",
            "placeholder:text-muted-foreground focus:outline-none",
            "min-h-[36px] max-h-[200px]"
          )}
          rows={1}
        />
        {/* Show Send when not running, Cancel when running */}
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send className="shrink-0 rounded-lg bg-primary p-1.5 text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            <Send className="h-4 w-4" />
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel className="shrink-0 rounded-lg border border-border p-1.5 text-foreground hover:bg-muted transition-colors">
            <Square className="h-4 w-4" />
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </ComposerPrimitive.Root>
    </div>
  )
}

// ── Agent type label lookup ────────────────────────────────────────────────

const AGENT_TYPE_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
}

// ── Main component ─────────────────────────────────────────────────────────

interface AgentChatProps {
  sessionId: string
  /** Auth token for the WebSocket connection (can be empty for cookie-based auth) */
  token?: string
  className?: string
  /** Session metadata (display only) */
  workingDir?: string
  agentType?: string
  /** Permission mode (interactive — maps to session.setMode) */
  permissionMode?: string
  onPermissionModeChange?: (mode: string) => void
}

/**
 * AgentChat provides the full chat UI for an ACP agent session.
 * Mount this with a sessionId; it connects via WebSocket automatically.
 */
export function AgentChat({
  sessionId,
  token = "",
  className,
  workingDir,
  agentType,
  permissionMode,
  onPermissionModeChange,
}: AgentChatProps) {
  const { runtime, connected, pendingPermissions, sendPermissionResponse, sendSetMode } =
    useAgentRuntime({ sessionId, token, enabled: true })

  const handlePermissionModeChange = (mode: string) => {
    onPermissionModeChange?.(mode)
    sendSetMode(mode)
  }

  const agentLabel = agentType ? (AGENT_TYPE_LABELS[agentType] ?? agentType) : "Claude Code"

  return (
    <AgentContextProvider value={{ sendPermissionResponse, pendingPermissions }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className={cn("flex flex-col h-full bg-background", className)}>
          {/* Connection status */}
          {!connected && (
            <div className="shrink-0 px-4 py-1.5 text-center text-[11px] text-muted-foreground bg-muted/50 border-b border-border">
              Connecting…
            </div>
          )}

          {/* Session header bar */}
          <div className="shrink-0 flex items-center gap-3 px-4 py-1.5">
            {/* Working directory */}
            {workingDir && (
              <div className="flex items-center gap-1 min-w-0 flex-1">
                <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground truncate" title={workingDir}>
                  {workingDir}
                </span>
              </div>
            )}

            {/* Agent type */}
            <div className="flex items-center gap-1 shrink-0">
              <Terminal className="h-3 w-3 text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">{agentLabel}</span>
            </div>

            {/* Permission mode selector */}
            <PermissionModeSelector
              value={(permissionMode as PermissionMode) ?? "default"}
              onChange={handlePermissionModeChange}
              showLabel
            />
          </div>

          {/* Thread viewport */}
          <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 py-4">
            <ThreadPrimitive.Empty>
              <div className="flex h-full min-h-[120px] items-center justify-center text-sm text-muted-foreground">
                Start a conversation
              </div>
            </ThreadPrimitive.Empty>

            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage,
              }}
            />

            <PendingPermissions />

            <ThreadPrimitive.ScrollToBottom className="sticky bottom-2 ml-auto mr-0 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background shadow-sm text-muted-foreground hover:text-foreground transition-colors">
              <ArrowDown className="h-4 w-4" />
            </ThreadPrimitive.ScrollToBottom>
          </ThreadPrimitive.Viewport>

          {/* Composer */}
          <AgentComposer />
        </div>
      </AssistantRuntimeProvider>
    </AgentContextProvider>
  )
}
