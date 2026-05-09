/**
 * ExitPlanModeTool -- renderer for the Claude Code ExitPlanMode tool call.
 *
 * The plan markdown ships in two places on the wire:
 *   - top-level content[0].content.text  (proper ACP content block)
 *   - rawInput.plan                       (duplicate)
 *
 * Backend StripHeavyToolCallContent removes rawInput.plan; the runtime
 * synthesizes `{ plan: <text> }` into `result` from the content block. We
 * still fall back to args.plan for legacy / pre-strip frames so persisted
 * sessions keep rendering.
 */
import { useState, useRef } from "react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { Streamdown } from "streamdown"
import { MessageDot, toolStatusToDotType, computeToolEffectiveStatus } from "../message-dot"

interface ExitPlanModeArgs {
  kind?: string
  plan?: string
  planFilePath?: string
  metaToolName?: string
  [key: string]: unknown
}

interface ExitPlanModeResult {
  plan?: string
  [key: string]: unknown
}

export function ExitPlanModeToolRenderer({
  args,
  result,
  status,
}: ToolCallMessagePartProps<ExitPlanModeArgs, unknown>) {
  const hasResult = result != null
  const effectiveStatus = computeToolEffectiveStatus(status, hasResult)
  const isComplete = effectiveStatus === "complete"
  const isRunning = effectiveStatus === "running"
  const isError = effectiveStatus === "incomplete"
  const isCancelled = effectiveStatus === "cancelled"
  const [expanded, setExpanded] = useState(true)
  const hasBeenExpandedRef = useRef(true)
  if (expanded) hasBeenExpandedRef.current = true

  const dotType = toolStatusToDotType(effectiveStatus)

  const resultPlan = result != null && typeof result === "object" && !Array.isArray(result)
    ? (result as ExitPlanModeResult).plan
    : undefined
  const planText =
    (typeof resultPlan === "string" && resultPlan) ||
    (typeof args?.plan === "string" && args.plan) ||
    ""

  const hasPlan = planText.length > 0

  const getSummaryLine = () => {
    if (isRunning && !hasPlan) return "Preparing plan..."
    if (isCancelled) return "Cancelled"
    if (isError) return "Error"
    if (isComplete) return "Plan ready"
    if (hasPlan) return "Plan ready"
    return null
  }

  const summaryLine = getSummaryLine()

  return (
    <div className={`font-mono text-[13px] leading-[1.5] ${isCancelled ? "opacity-60" : ""}`}>
      <button
        onClick={() => hasPlan && setExpanded(!expanded)}
        className={`flex items-start gap-2 w-full text-left ${hasPlan ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
      >
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className={`font-semibold text-foreground ${isCancelled ? "line-through" : ""}`}>
            Plan
          </span>
          {hasPlan && (
            <span className="text-[11px] shrink-0 text-muted-foreground/60">
              {expanded ? "▾" : "▸"}
            </span>
          )}
        </div>
      </button>

      {summaryLine && (
        <div className="flex gap-2 ml-5">
          <span className={`select-none ${isError ? "text-destructive" : "text-muted-foreground"}`}>{"└"}</span>
          <span className={`truncate ${isError ? "text-destructive" : "text-muted-foreground"}`}>{summaryLine}</span>
        </div>
      )}

      {hasBeenExpandedRef.current && (
        <div className={`collapsible-grid ${expanded && hasPlan ? "" : "collapsed"}`}>
          <div className="collapsible-grid-content">
            <div className="mt-2 ml-5 p-3 rounded-md overflow-y-auto bg-muted/50 max-h-[60vh] font-sans text-sm">
              <Streamdown>{planText}</Streamdown>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
