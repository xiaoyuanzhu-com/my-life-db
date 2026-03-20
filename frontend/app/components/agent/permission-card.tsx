/**
 * PermissionCard — rendered when a tool call has status "requires-action"
 *
 * Shows what tool is being requested and renders ACP permission options
 * (Allow Once, Allow Always, Reject, Reject Always) as buttons.
 * Calls sendPermissionResponse(toolCallId, optionId) when the user clicks.
 */
import { useAgentContext } from "./agent-context"
import type { PermissionOption } from "~/hooks/use-agent-websocket"
import { ShieldQuestion } from "lucide-react"

interface PermissionCardProps {
  toolCallId: string
  toolName: string
  args: unknown
  options: PermissionOption[]
}

/** Determine button style by kind */
function buttonClass(kind: string): string {
  switch (kind) {
    case "allow":
    case "allow_once":
      return "bg-primary text-primary-foreground hover:bg-primary/90"
    case "allow_always":
    case "allow_session":
      return "border border-border text-foreground hover:bg-muted"
    case "reject":
    case "reject_once":
    case "deny":
      return "border border-border text-foreground hover:bg-muted"
    case "reject_always":
      return "border border-destructive/40 text-destructive hover:bg-destructive/10"
    default:
      return "border border-border text-foreground hover:bg-muted"
  }
}

export function PermissionCard({
  toolCallId,
  toolName,
  args,
  options,
}: PermissionCardProps) {
  const { sendPermissionResponse } = useAgentContext()

  const previewStr =
    args != null
      ? typeof args === "string"
        ? args
        : JSON.stringify(args, null, 2)
      : null

  return (
    <div className="my-2 rounded-md border border-border bg-background p-3 text-sm">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <ShieldQuestion className="h-4 w-4 shrink-0 text-amber-500" />
        <span className="font-medium text-foreground text-[13px]">
          Permission required
        </span>
      </div>

      {/* Tool name */}
      <div className="mb-1 font-mono text-xs text-muted-foreground truncate">
        {toolName}
      </div>

      {/* Input preview */}
      {previewStr && (
        <div className="mb-3 rounded border border-border bg-muted/50 px-2 py-1.5">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed max-h-32 text-foreground">
            {previewStr}
          </pre>
        </div>
      )}

      {/* Permission option buttons */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            onClick={() => sendPermissionResponse(toolCallId, option.optionId)}
            className={[
              "px-2.5 py-1 rounded-md text-[12px] transition-colors cursor-pointer",
              buttonClass(option.kind),
            ].join(" ")}
          >
            {option.name}
          </button>
        ))}
      </div>
    </div>
  )
}
