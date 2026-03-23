/**
 * MessageDot — colored dot indicator for ACP message/tool status.
 *
 * Displays an 8px circle within a 20px container.
 * Supports pulsing animation for in-progress states.
 */

export type MessageDotType =
  | "assistant"
  | "assistant-wip"
  | "tool-pending"
  | "tool-completed"
  | "tool-failed"
  | "system"

interface MessageDotProps {
  type: MessageDotType
}

const DOT_STYLES: Record<MessageDotType, { color: string; pulse: boolean }> = {
  "assistant":      { color: "#5F6368", pulse: false },
  "assistant-wip":  { color: "#5F6368", pulse: true },
  "tool-pending":   { color: "#5F6368", pulse: true },
  "tool-completed": { color: "#22C55E", pulse: false },
  "tool-failed":    { color: "#D92D20", pulse: false },
  "system":         { color: "#22C55E", pulse: false },
}

export function MessageDot({ type }: MessageDotProps) {
  const style = DOT_STYLES[type]

  return (
    <span
      className={`inline-flex items-center justify-center shrink-0 h-5 w-5 ${style.pulse ? "animate-pulse" : ""}`}
    >
      <span
        className="block rounded-full"
        style={{
          width: 8,
          height: 8,
          backgroundColor: style.color,
        }}
      />
    </span>
  )
}

/** Map a tool call status type to a MessageDotType */
export function toolStatusToDotType(
  statusType: string
): MessageDotType {
  if (statusType === "complete") return "tool-completed"
  if (statusType === "requires-action") return "tool-failed"
  if (statusType === "running") return "tool-pending"
  return "tool-pending"
}
