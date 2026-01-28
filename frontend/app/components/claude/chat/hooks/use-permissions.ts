import { useState, useMemo, useCallback } from 'react'
import type {
  PermissionRequest,
  PermissionDecision,
  ControlResponse,
} from '~/types/claude'

export interface UsePermissionsResult {
  /** List of pending permission requests (no matching response yet) */
  pendingPermissions: PermissionRequest[]
  /** Handle incoming control_request message */
  handleControlRequest: (data: {
    request_id: string
    request: { tool_name: string; input?: Record<string, unknown> }
  }) => void
  /** Handle incoming control_response message */
  handleControlResponse: (data: { request_id: string }) => void
  /** Build a ControlResponse payload (caller sends via WebSocket) */
  buildPermissionResponse: (
    requestId: string,
    decision: PermissionDecision
  ) => ControlResponse | null
  /** Reset all permission state (call on session change) */
  reset: () => void
}

/**
 * Manages permission request/response tracking.
 * Tracks control_request messages and matches them with control_response messages.
 * Provides helper to build response payloads for sending.
 */
export function usePermissions(): UsePermissionsResult {
  // Maps request_id to request data
  const [controlRequests, setControlRequests] = useState<Map<string, PermissionRequest>>(new Map())
  // Set of request_ids that have received responses
  const [controlResponses, setControlResponses] = useState<Set<string>>(new Set())

  // Compute pending permissions (requests without matching responses)
  const pendingPermissions = useMemo(() => {
    const pending: PermissionRequest[] = []
    for (const [requestId, request] of controlRequests) {
      if (!controlResponses.has(requestId)) {
        pending.push(request)
      }
    }
    return pending
  }, [controlRequests, controlResponses])

  const handleControlRequest = useCallback(
    (data: {
      request_id: string
      request: { tool_name: string; input?: Record<string, unknown> }
    }) => {
      console.log('[usePermissions] Received control_request:', data.request_id, data.request.tool_name)
      setControlRequests((prev) => {
        const next = new Map(prev)
        next.set(data.request_id, {
          requestId: data.request_id,
          toolName: data.request.tool_name,
          input: data.request.input || {},
        })
        return next
      })
    },
    []
  )

  const handleControlResponse = useCallback((data: { request_id: string }) => {
    console.log('[usePermissions] Received control_response:', data.request_id)
    setControlResponses((prev) => {
      const next = new Set(prev)
      next.add(data.request_id)
      return next
    })
  }, [])

  const buildPermissionResponse = useCallback(
    (requestId: string, decision: PermissionDecision): ControlResponse | null => {
      const request = controlRequests.get(requestId)
      if (!request) {
        console.warn('[usePermissions] No permission request found for id:', requestId)
        return null
      }

      // Map decision to Claude's behavior format
      const behavior = decision === 'deny' ? 'deny' : 'allow'
      const alwaysAllow = decision === 'allowSession'

      const response: ControlResponse = {
        type: 'control_response',
        request_id: requestId,
        response: {
          subtype: 'success',
          response: {
            behavior,
            // Include message for deny (required by Anthropic API - content can't be empty when is_error=true)
            ...(behavior === 'deny' && {
              message: `Permission denied by user for tool: ${request.toolName}`,
            }),
          },
        },
        // Send tool_name and always_allow for "always allow for session" feature
        tool_name: request.toolName,
        always_allow: alwaysAllow,
      }

      return response
    },
    [controlRequests]
  )

  const reset = useCallback(() => {
    setControlRequests(new Map())
    setControlResponses(new Set())
  }, [])

  return {
    pendingPermissions,
    handleControlRequest,
    handleControlResponse,
    buildPermissionResponse,
    reset,
  }
}
