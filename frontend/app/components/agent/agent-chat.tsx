/**
 * AgentChat — Chat UI component backed by the ACP WebSocket runtime.
 *
 * Expects to be rendered inside an AssistantRuntimeProvider + AgentContextProvider
 * (provided by the route). Uses ThreadPrimitive + MessagePrimitive to render the
 * conversation. Tool calls are dispatched to kind-specific renderers. Permission
 * cards appear above the composer as popups.
 */
import { useEffect, useRef, useState, useCallback } from "react"
import {
  ThreadPrimitive,
  ComposerPrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react"
import { useComposerRuntime } from "@assistant-ui/react"
import { Send, Square, ArrowDown } from "lucide-react"
import { cn } from "~/lib/utils"
import { useDraftPersistence } from "~/hooks/use-draft-persistence"
import { useAgentContext } from "./agent-context"
import { PermissionCard } from "./permission-card"
import { UserMessage } from "./user-message"
import { createAssistantMessage } from "./assistant-message"
import { ExecuteToolRenderer } from "./tools/execute-tool"
import { ReadToolRenderer } from "./tools/read-tool"
import { EditToolRenderer } from "./tools/edit-tool"
import { SearchToolRenderer } from "./tools/search-tool"
import { FetchToolRenderer } from "./tools/fetch-tool"
import { ToolFallback } from "~/components/assistant-ui/tool-fallback"
import { FolderPicker } from "./folder-picker"
import { AgentTypeSelector, type AgentType } from "./agent-type-selector"
import { PermissionModeSelector, type PermissionMode } from "./permission-mode-selector"
import { ConnectionStatusBanner } from "./connection-status-banner"
import { AgentWIP } from "./agent-wip"
import { PlanView } from "./plan-view"
import { SlashCommandPopover } from "./slash-command-popover"
import { FileTagPopover } from "./file-tag-popover"
import { useIsMobile } from "~/hooks/use-is-mobile"

// ── Tool dispatch ──────────────────────────────────────────────────────────

/**
 * Infer ACP ToolKind from the tool name and args.
 * toolName is the ACP title, e.g., "Read /src/main.go".
 */
function inferToolKind(toolName: string, args: Record<string, unknown>): string {
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

// ── Message components ─────────────────────────────────────────────────────

const toolsConfig = {
  Override: AcpToolRenderer,
} as const

// Create AssistantMessage with tools config baked in
const AssistantMessage = createAssistantMessage(toolsConfig)

// ── Pending permissions ────────────────────────────────────────────────────

function PendingPermissions() {
  const { pendingPermissions } = useAgentContext()

  if (pendingPermissions.size === 0) return null

  const entries = Array.from(pendingPermissions.entries())

  return (
    <div className="max-w-3xl mx-auto space-y-2 px-4 py-2">
      {entries.map(([toolCallId, entry], index) => (
        <PermissionCard
          key={toolCallId}
          toolCallId={toolCallId}
          toolName={entry.toolName}
          args={null}
          options={entry.options}
          isFirst={index === 0}
        />
      ))}
    </div>
  )
}

// ── WIP indicator (shown when agent is running) ────────────────────────────

function AgentWIPIndicator() {
  return (
    <ThreadPrimitive.If running>
      <AgentWIP />
    </ThreadPrimitive.If>
  )
}

// ── Draft persistence sync ──────────────────────────────────────────────────

/** Syncs draft text between assistant-ui composer state and localStorage */
function DraftPersistenceSync({ sessionId }: { sessionId?: string }) {
  const { content, setContent, clearDraft } = useDraftPersistence(sessionId)
  const composerRuntime = useComposerRuntime()
  const restoredRef = useRef(false)

  // Restore draft from localStorage on mount
  useEffect(() => {
    if (content && !restoredRef.current) {
      restoredRef.current = true
      composerRuntime.setText(content)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Persist draft: subscribe to composer text changes
  useEffect(() => {
    return composerRuntime.subscribe(() => {
      const state = composerRuntime.getState()
      if (state.text !== content) {
        if (state.text) {
          setContent(state.text)
        } else if (content) {
          // Text was cleared (e.g., after send) — clear draft
          clearDraft()
        }
      }
    })
  }, [composerRuntime, content, setContent, clearDraft])

  return null
}

// ── Composer ───────────────────────────────────────────────────────────────

interface AgentComposerProps {
  workingDir?: string
  onWorkingDirChange?: (path: string) => void
  agentType?: string
  onAgentTypeChange?: (type: AgentType) => void
  permissionMode?: string
  onPermissionModeChange?: (mode: PermissionMode) => void
}

function AgentComposer({
  workingDir,
  onWorkingDirChange,
  agentType,
  onAgentTypeChange,
  permissionMode,
  onPermissionModeChange,
}: AgentComposerProps) {
  const composerInputRef = useRef<HTMLTextAreaElement>(null)

  return (
    <div className="bg-background py-3">
     <div className="max-w-3xl mx-auto px-3">
      <ComposerPrimitive.Root className="relative rounded-xl border border-border bg-muted/30 px-3 py-2">
        <SlashCommandPopover textareaRef={composerInputRef} />
        <FileTagPopover textareaRef={composerInputRef} />
        <ComposerPrimitive.Input
          ref={composerInputRef}
          placeholder="Message..."
          className={cn(
            "w-full resize-none bg-transparent text-sm text-foreground",
            "placeholder:text-muted-foreground focus:outline-none",
            "min-h-[36px] max-h-[200px]"
          )}
          rows={1}
        />
        {/* Actions row */}
        <div className="flex items-center justify-between mt-2">
          {/* Left side */}
          <div className="flex items-center gap-1.5 sm:gap-3">
            <FolderPicker
              value={workingDir || ''}
              onChange={onWorkingDirChange}
              readOnly={!onWorkingDirChange}
            />
            <AgentTypeSelector
              value={(agentType as AgentType) ?? 'claude_code'}
              onChange={onAgentTypeChange ?? (() => {})}
              disabled={!onAgentTypeChange}
              showLabel
            />
            <PermissionModeSelector
              value={(permissionMode as PermissionMode) ?? 'default'}
              onChange={onPermissionModeChange ?? (() => {})}
              disabled={!onPermissionModeChange}
              showLabel
            />
          </div>
          {/* Right side - send/cancel buttons */}
          <div className="flex items-center gap-1 sm:gap-2">
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
          </div>
        </div>
      </ComposerPrimitive.Root>
     </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

interface AgentChatProps {
  /**
   * Session ID — used for draft persistence and connection status display.
   * Pass an empty string when there is no active session (new-session empty state).
   */
  sessionId: string
  className?: string
  /** Working directory (shown in composer, editable if onWorkingDirChange provided) */
  workingDir?: string
  onWorkingDirChange?: (path: string) => void
  /** Agent type (shown in composer, editable if onAgentTypeChange provided) */
  agentType?: string
  onAgentTypeChange?: (type: AgentType) => void
  /** Permission mode (interactive — maps to session.setMode) */
  permissionMode?: string
  onPermissionModeChange?: (mode: string) => void
}

/** Hook to track scroll direction for hiding composer on mobile */
function useScrollDirection() {
  const [hidden, setHidden] = useState(false)
  const lastScrollTopRef = useRef(0)
  const scrollThreshold = 10

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget
    const scrollTop = target.scrollTop
    const maxScroll = target.scrollHeight - target.clientHeight
    const delta = scrollTop - lastScrollTopRef.current

    // At the bottom — always show
    if (scrollTop >= maxScroll - 20) {
      setHidden(false)
    } else if (delta > scrollThreshold) {
      // Scrolling down — hide
      setHidden(true)
    } else if (delta < -scrollThreshold) {
      // Scrolling up — show
      setHidden(false)
    }

    lastScrollTopRef.current = scrollTop
  }, [])

  return { hidden, onScroll }
}

/**
 * AgentChat provides the full chat UI for an ACP agent session.
 * Mount with a sessionId to connect via WebSocket. When sessionId is empty,
 * it shows the empty state with the composer.
 */
export function AgentChat({
  sessionId,
  className,
  workingDir,
  onWorkingDirChange,
  agentType,
  onAgentTypeChange,
  permissionMode,
  onPermissionModeChange,
}: AgentChatProps) {
  const hasSession = Boolean(sessionId)
  const isMobile = useIsMobile()
  const { hidden: composerHidden, onScroll: onViewportScroll } = useScrollDirection()
  const { connected, pendingPermissions, planEntries, sendSetMode } = useAgentContext()

  const handlePermissionModeChange = (mode: PermissionMode) => {
    onPermissionModeChange?.(mode)
    sendSetMode(mode)
  }

  // On mobile, hide composer when scrolling down (unless permissions are pending)
  const shouldHideComposer = isMobile && composerHidden && pendingPermissions.size === 0

  return (
    <>
      <DraftPersistenceSync sessionId={hasSession ? sessionId : undefined} />
      <div className={cn("flex flex-col h-full bg-background", className)}>
        {/* Connection status banner */}
        <ConnectionStatusBanner connected={connected} hasSession={hasSession} />

        {/* Thread viewport */}
        <ThreadPrimitive.Viewport
          className="flex-1 overflow-y-auto py-4"
          onScroll={isMobile ? onViewportScroll : undefined}
        >
          <div className="w-full max-w-3xl mx-auto px-4">
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

            {/* Agent WIP indicator — rendered as part of the message list */}
            <AgentWIPIndicator />
          </div>

          <ThreadPrimitive.ScrollToBottom className="sticky bottom-2 ml-auto mr-4 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background shadow-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowDown className="h-4 w-4" />
          </ThreadPrimitive.ScrollToBottom>
        </ThreadPrimitive.Viewport>

        {/* Plan entries — shown between thread and composer */}
        {planEntries.length > 0 && <PlanView entries={planEntries} />}

        {/* Permission cards — pop up above composer */}
        <PendingPermissions />

        {/* Composer — hidden on mobile when scrolling down */}
        <div
          className={cn(
            "transition-all duration-200 overflow-hidden",
            shouldHideComposer ? "max-h-0 opacity-0" : "max-h-[300px] opacity-100"
          )}
        >
          <AgentComposer
            workingDir={workingDir}
            onWorkingDirChange={onWorkingDirChange}
            agentType={agentType}
            onAgentTypeChange={onAgentTypeChange}
            permissionMode={permissionMode}
            onPermissionModeChange={handlePermissionModeChange}
          />
        </div>
      </div>
    </>
  )
}
