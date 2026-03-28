/**
 * SkillTool -- renderer for ACP "Skill" tool calls
 *
 * - Header: MessageDot + "Skill" (bold) + skill name (muted) + chevron
 * - Summary line with tree connector showing "Loaded skill" or status
 * - Expandable: click header to show raw result
 */
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType } from "../message-dot"

interface SkillArgs {
  kind?: string
  skill?: string
  args?: string
  metaToolName?: string
  [key: string]: unknown
}

interface SkillResult {
  commandName?: string
  success?: boolean
  [key: string]: unknown
}

export function SkillToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<SkillArgs, unknown>) {
  const hasResult = result != null
  const effectiveStatus = (status.type === "incomplete" && !hasResult) || status.type === "requires-action" ? "running" : status.type
  const isComplete = effectiveStatus === "complete"
  const isRunning = effectiveStatus === "running"
  const isError = effectiveStatus === "incomplete"
  // Extract skill name from args or toolName
  const skillName = args?.skill || (() => {
    const match = toolName.match(/^Skill\s+(.+)$/i)
    return match ? match[1].trim() : null
  })() || "unknown"

  // Parse result
  const skillResult = result != null && typeof result === "object" && !Array.isArray(result)
    ? result as SkillResult
    : null
  const succeeded = skillResult?.success !== false

  const dotType = isError || (isComplete && !succeeded)
    ? "tool-failed" as const
    : toolStatusToDotType(effectiveStatus)

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: dot + "Skill" bold + skill name */}
      <div className="flex items-start gap-2">
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-foreground">
            Skill
          </span>
          <span className="ml-2 text-muted-foreground truncate">
            {skillName}
          </span>
        </div>
      </div>

      {/* Summary line */}
      {isComplete && (
        <div className={`flex gap-2 ml-5 ${succeeded ? "text-muted-foreground" : "text-destructive"}`}>
          <span className="select-none">{"\u2514"}</span>
          <span>{succeeded ? "Loaded skill" : "Failed to load skill"}</span>
        </div>
      )}

      {isRunning && (
        <div className="flex gap-2 ml-5 text-muted-foreground">
          <span className="select-none">{"\u2514"}</span>
          <span>Loading...</span>
        </div>
      )}

      {isError && (
        <div className="flex gap-2 ml-5 text-destructive">
          <span className="select-none">{"\u2514"}</span>
          <span>Error</span>
        </div>
      )}
    </div>
  )
}
