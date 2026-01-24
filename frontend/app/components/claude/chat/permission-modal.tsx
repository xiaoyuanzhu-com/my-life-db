import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Shield, AlertTriangle } from 'lucide-react'
import type { PermissionRequest, PermissionDecision } from '~/types/claude'

interface PermissionModalProps {
  request: PermissionRequest
  onDecision: (decision: PermissionDecision) => void
}

export function PermissionModal({ request, onDecision }: PermissionModalProps) {
  // Determine risk level based on tool
  const isHighRisk = ['Bash', 'Write', 'Edit'].includes(request.toolName)

  return (
    <Dialog open onOpenChange={() => onDecision('deny')}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isHighRisk ? (
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
            ) : (
              <Shield className="h-5 w-5 text-primary" />
            )}
            Permission Required
          </DialogTitle>
          <DialogDescription>
            Claude wants to use the <strong>{request.toolName}</strong> tool
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Tool parameters */}
          <div
            className="rounded-lg p-3"
            style={{ backgroundColor: 'var(--claude-bg-subtle)' }}
          >
            <div className="text-xs text-muted-foreground mb-2">Details</div>
            <ParameterPreview
              toolName={request.toolName}
              input={request.input}
            />
          </div>

          {/* Warning for high-risk operations */}
          {isHighRisk && (
            <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3">
              <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5" />
              <div className="text-sm text-yellow-700 dark:text-yellow-400">
                This operation may modify files or execute commands on your system.
                Review carefully before approving.
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            onClick={() => onDecision('deny')}
          >
            Deny
          </Button>
          <Button
            variant="default"
            onClick={() => onDecision('allow')}
          >
            Allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ParameterPreview({
  toolName,
  input,
}: {
  toolName: string
  input: Record<string, unknown>
}) {
  // Render tool-specific parameter preview
  switch (toolName) {
    case 'Bash':
      return (
        <pre
          className="text-xs font-mono rounded p-2 overflow-x-auto"
          style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
        >
          $ {input.command as string}
        </pre>
      )

    case 'Read':
      return (
        <div className="text-sm font-mono">
          {input.file_path as string}
        </div>
      )

    case 'Write':
    case 'Edit':
      return (
        <div className="space-y-2">
          <div className="text-sm font-mono">
            {input.file_path as string}
          </div>
          {toolName === 'Edit' && (
            <div className="text-xs text-muted-foreground">
              Replacing text in file
            </div>
          )}
        </div>
      )

    case 'WebFetch':
      return (
        <div className="text-sm font-mono truncate">
          {input.url as string}
        </div>
      )

    case 'WebSearch':
      return (
        <div className="text-sm font-mono">
          Search: {input.query as string}
        </div>
      )

    default:
      return (
        <pre className="text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      )
  }
}
