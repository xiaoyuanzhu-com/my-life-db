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
import type { PermissionRequest, PermissionDecision, ToolParams } from '~/types/claude'

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
          {/* Description */}
          {request.description && (
            <p className="text-sm text-foreground">{request.description}</p>
          )}

          {/* Tool parameters */}
          <div className="rounded-lg bg-muted p-3">
            <div className="text-xs text-muted-foreground mb-2">Details</div>
            <ParameterPreview
              toolName={request.toolName}
              parameters={request.parameters}
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
            variant="secondary"
            onClick={() => onDecision('allow')}
          >
            Allow Once
          </Button>
          <Button
            variant="default"
            onClick={() => onDecision('always_allow')}
          >
            Always Allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ParameterPreview({
  toolName,
  parameters,
}: {
  toolName: string
  parameters: ToolParams
}) {
  // Render tool-specific parameter preview
  switch (toolName) {
    case 'Bash':
      return (
        <pre className="text-xs font-mono bg-background rounded p-2 overflow-x-auto">
          $ {(parameters as { command?: string }).command}
        </pre>
      )

    case 'Read':
      return (
        <div className="text-sm font-mono">
          {(parameters as { file_path?: string }).file_path}
        </div>
      )

    case 'Write':
    case 'Edit':
      return (
        <div className="space-y-2">
          <div className="text-sm font-mono">
            {(parameters as { file_path?: string }).file_path}
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
          {(parameters as { url?: string }).url}
        </div>
      )

    default:
      return (
        <pre className="text-xs font-mono overflow-x-auto">
          {JSON.stringify(parameters, null, 2)}
        </pre>
      )
  }
}
