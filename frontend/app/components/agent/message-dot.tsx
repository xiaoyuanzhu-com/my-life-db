/**
 * MessageDot -- colored dot indicator for ACP message/tool status.
 *
 * Displays a 6px circle within a 20px container (matching the old Claude Code
 * chat UI). Supports pulsing animation for in-progress states.
 */

export type MessageDotType =
  | "assistant"
  | "assistant-wip"
  | "tool-pending"
  | "tool-completed"
  | "tool-failed"
  | "tool-cancelled"
  | "system"

interface MessageDotProps {
  type: MessageDotType
}

const DOT_STYLES: Record<MessageDotType, { color: string; char: string; pulse: boolean }> = {
  "assistant":      { color: "#5F6368", char: "\u25CF", pulse: false },
  "assistant-wip":  { color: "#5F6368", char: "\u25CF", pulse: true },
  "tool-pending":   { color: "#9CA3AF", char: "\u25CF", pulse: true },
  "tool-completed": { color: "#22C55E", char: "\u25CF", pulse: false },
  "tool-failed":    { color: "#D92D20", char: "\u25CF", pulse: false },
  "tool-cancelled": { color: "#9CA3AF", char: "\u25CF", pulse: false },
  "system":         { color: "#22C55E", char: "\u25CF", pulse: false },
}

export function MessageDot({ type }: MessageDotProps) {
  const style = DOT_STYLES[type]

  return (
    <span
      className={`select-none font-mono text-[8px] h-5 flex items-center shrink-0 ${style.pulse ? "animate-pulse" : ""}`}
      style={{ color: style.color }}
    >
      {style.char}
    </span>
  )
}

/** Map a tool call status type to a MessageDotType */
export function toolStatusToDotType(
  statusType: string
): MessageDotType {
  if (statusType === "complete") return "tool-completed"
  if (statusType === "cancelled") return "tool-cancelled"
  if (statusType === "incomplete") return "tool-failed"
  if (statusType === "requires-action") return "tool-pending"
  if (statusType === "running") return "tool-pending"
  return "tool-pending"
}

/**
 * Compute the effective status for a tool call, collapsing assistant-ui's
 * status model into a simpler set: "complete" | "running" | "incomplete" | "cancelled".
 *
 * - incomplete + reason "cancelled" → "cancelled" (interrupted turn, gray static dot)
 * - incomplete + no result → "running" (tool still executing or history replay)
 * - requires-action → "running"
 * - otherwise → pass through (complete, incomplete with result = error)
 */
export function computeToolEffectiveStatus(
  status: { type: string; reason?: string },
  hasResult: boolean
): string {
  if (status.type === "incomplete" && status.reason === "cancelled") return "cancelled"
  if ((status.type === "incomplete" && !hasResult) || status.type === "requires-action") return "running"
  return status.type
}
