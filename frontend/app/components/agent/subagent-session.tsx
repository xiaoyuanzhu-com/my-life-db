/**
 * SubagentSession — renders a collapsible sub-session for an Agent tool call.
 * Styled like regular tool call blocks (Read/Edit/Execute) with:
 * - Header: MessageDot + "Agent" (bold) + description (muted) + tool count + chevron
 * - Collapsible content showing child messages
 * Recursive: if a child tool call has its own children, renders another SubagentSession.
 */
import { useState } from "react"
import type { ThreadMessageLike } from "@assistant-ui/react"
import type { ToolCallMessagePartStatus } from "@assistant-ui/react"
import type { ReadonlyJSONObject } from "assistant-stream/utils"
import { MarkdownContent } from "~/components/agent/markdown-content"
import { AcpToolRenderer } from "~/components/agent/tool-dispatch"
import { MessageDot, toolStatusToDotType, computeToolEffectiveStatus } from "./message-dot"

interface SubagentSessionProps {
  toolCallId: string
  toolName: string
  status?: ToolCallMessagePartStatus
  args?: Record<string, unknown>
  result?: unknown
  childMessages: ThreadMessageLike[]
  childrenMap: Map<string, ThreadMessageLike[]>
}

/** Extract the response text from the Agent tool result */
function extractResponseText(result: unknown): string | null {
  if (!result || typeof result !== "object") return null
  const r = result as Record<string, unknown>
  // toolResponse shape: { content: [{ text: "...", type: "text" }], ... }
  if (Array.isArray(r.content)) {
    const texts = (r.content as Array<Record<string, unknown>>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
    if (texts.length > 0) return texts.join("\n\n")
  }
  if (typeof r.text === "string") return r.text
  return null
}

/** Count all tool-call parts across child messages */
function countToolCalls(messages: ThreadMessageLike[]): number {
  let count = 0
  for (const msg of messages) {
    if (typeof msg.content === "string") continue
    for (const part of msg.content) {
      if (part.type === "tool-call") count++
    }
  }
  return count
}

// ── ToolCall content part shape (from ThreadMessageLike) ──────────────
interface ToolCallPart {
  readonly type: "tool-call"
  readonly toolCallId?: string
  readonly toolName: string
  readonly args?: ReadonlyJSONObject
  readonly argsText?: string
  readonly result?: unknown
  readonly isError?: boolean
}

// ── SubagentMessage — renders a single ThreadMessageLike inside a sub-session ──

function SubagentMessage({
  message,
  childrenMap,
}: {
  message: ThreadMessageLike
  childrenMap: Map<string, ThreadMessageLike[]>
}) {
  // String content (simple text message)
  if (typeof message.content === "string") {
    if (message.role === "user") {
      return (
        <div className="py-1">
          <p className="text-xs text-muted-foreground">{message.content}</p>
        </div>
      )
    }
    return (
      <div className="flex items-start gap-1.5 py-1">
        <MessageDot type="assistant" />
        <MarkdownContent text={message.content} className="text-xs" />
      </div>
    )
  }

  // User role — render all text parts as muted
  if (message.role === "user") {
    const textParts = message.content.filter((p) => p.type === "text") as Array<{
      type: "text"
      text: string
    }>
    if (textParts.length === 0) return null
    return (
      <div className="py-1">
        {textParts.map((part, i) => (
          <MarkdownContent
            key={i}
            text={part.text}
            className="text-xs text-muted-foreground"
          />
        ))}
      </div>
    )
  }

  // Assistant role — iterate content parts
  return (
    <div className="space-y-1 py-1">
      {message.content.map((part, i) => {
        if (part.type === "text") {
          const textPart = part as { type: "text"; text: string }
          if (!textPart.text.trim()) return null
          return (
            <div key={i} className="flex items-start gap-1.5">
              <MessageDot type="assistant" />
              <MarkdownContent text={textPart.text} className="text-xs" />
            </div>
          )
        }

        if (part.type === "reasoning") {
          // Skip reasoning blocks for cleanliness
          return null
        }

        if (part.type === "tool-call") {
          const toolPart = part as ToolCallPart
          const toolCallId = toolPart.toolCallId ?? `anon-${i}`
          const children = childrenMap.get(toolCallId)

          if (children && children.length > 0) {
            // Recursive: render another SubagentSession
            return (
              <SubagentSession
                key={toolCallId}
                toolCallId={toolCallId}
                toolName={toolPart.toolName}
                status={
                  toolPart.result !== undefined
                    ? { type: "complete" as const }
                    : { type: "running" as const }
                }
                childMessages={children}
                childrenMap={childrenMap}
              />
            )
          }

          // No children — render with AcpToolRenderer directly
          return (
            <AcpToolRenderer
              key={toolCallId}
              type="tool-call"
              toolCallId={toolCallId}
              toolName={toolPart.toolName}
              args={(toolPart.args ?? {}) as ReadonlyJSONObject}
              argsText={toolPart.argsText ?? JSON.stringify(toolPart.args ?? {})}
              result={toolPart.result}
              isError={toolPart.isError}
              status={
                toolPart.result !== undefined
                  ? { type: "complete" }
                  : { type: "running" }
              }
              addResult={() => {}}
              resume={() => {}}
            />
          )
        }

        // Unknown part type — skip
        return null
      })}
    </div>
  )
}

// ── SubagentSession — main exported component ─────────────────────────

export function SubagentSession({
  toolCallId,
  toolName,
  status,
  args,
  result,
  childMessages,
  childrenMap,
}: SubagentSessionProps) {
  const hasResult = status?.type === "complete" || status?.type === "incomplete"
  const effectiveStatus = computeToolEffectiveStatus(
    status ?? { type: "running" },
    hasResult
  )
  const isComplete = effectiveStatus === "complete"
  const [expanded, setExpanded] = useState(!isComplete)
  const toolCount = countToolCalls(childMessages)
  const dotType = toolStatusToDotType(effectiveStatus)

  // Extract description from toolName (e.g., "Task task-id: description")
  const description = toolName !== "Agent" ? toolName : ""

  // Extract prompt and response
  const prompt = typeof args?.prompt === "string" ? args.prompt : null
  const responseText = extractResponseText(result)

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: dot + "Agent" bold + description + tool count + chevron */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-2 w-full text-left cursor-pointer hover:opacity-80"
      >
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-semibold text-foreground">Agent</span>
          {description && (
            <span className="truncate text-muted-foreground">{description}</span>
          )}
          {toolCount > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
              {toolCount}
            </span>
          )}
          <span className="text-[11px] shrink-0 text-muted-foreground/60">
            {expanded ? "\u25BE" : "\u25B8"}
          </span>
        </div>
      </button>

      {/* Summary line when collapsed */}
      {!expanded && isComplete && (
        <div className="flex gap-2 ml-5 text-muted-foreground">
          <span className="select-none">{"\u2514"}</span>
          <span>
            {toolCount} tool call{toolCount !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Running state */}
      {!expanded && !isComplete && (
        <div className="flex gap-2 ml-5 text-muted-foreground">
          <span className="select-none">{"\u2514"}</span>
          <span>Running...</span>
        </div>
      )}

      {/* Expanded content */}
      <div className={`collapsible-grid ${expanded ? "" : "collapsed"}`}>
        <div className="collapsible-grid-content">
          <div className="mt-1 ml-5 space-y-2">
            {/* Prompt — styled like user message bubble */}
            {prompt && (
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl bg-primary px-3 py-2 text-xs break-words">
                  <MarkdownContent
                    text={prompt}
                    className="text-primary-foreground [&_a]:text-primary-foreground/80 [&_code]:bg-primary-foreground/10 [&_pre]:bg-primary-foreground/10 [&_pre]:border-primary-foreground/20"
                  />
                </div>
              </div>
            )}

            {/* Child messages — internal tool calls */}
            <div className="space-y-1">
              {childMessages.map((msg, i) => (
                <SubagentMessage
                  key={msg.id ?? `sub-${toolCallId}-${i}`}
                  message={msg}
                  childrenMap={childrenMap}
                />
              ))}
            </div>

            {/* Response — styled like assistant message */}
            {responseText && (
              <div className="flex items-start gap-2">
                <MessageDot type="assistant" />
                <div className="flex-1 min-w-0">
                  <MarkdownContent text={responseText} className="text-xs" />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
