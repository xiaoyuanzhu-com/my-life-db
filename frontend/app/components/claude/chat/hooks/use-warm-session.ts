import { useState, useRef, useEffect, useCallback } from 'react'
import { api } from '~/lib/api'
import type { InitData } from './use-slash-commands'

/**
 * Session data returned by the promote API, matching the backend Session.ToJSON() shape.
 */
interface PromotedSession {
  id: string
  title: string
  workingDir: string
  createdAt: number
  lastActivity: number
  lastUserActivity: number
  sessionState: string
  git?: { isRepo: boolean; branch?: string; remoteUrl?: string }
  permissionMode?: string
}

export interface UseWarmSessionResult {
  /** InitData extracted from the system:init message, or null if not yet received. */
  initData: InitData | null
  /** Awaitable — resolves to session ID once creation completes. Rejects if creation failed. */
  getSessionId: () => Promise<string>
  /** Promote the phantom session: set title, make visible, return session data. */
  promote: (title: string) => Promise<PromotedSession>
}

/**
 * Eagerly creates a phantom Claude session and connects a WebSocket to receive
 * the system:init message (which contains skills and slash commands).
 *
 * The session is invisible ("phantom") — excluded from session listings and SSE
 * events — until promoted via `promote()` when the user sends their first message.
 *
 * Lifecycle:
 * - On mount (when enabled): creates phantom session, connects WebSocket
 * - On workingDir/permissionMode change: tears down old session, creates new one
 * - On disable or unmount: closes WebSocket, deletes phantom session (unless promoted)
 *
 * @param workingDir - Working directory for the session
 * @param permissionMode - Permission mode for the session
 * @param enabled - Only creates a session when true (typically: !activeSessionId && isAuthenticated)
 */
export function useWarmSession(
  workingDir: string,
  permissionMode: string,
  enabled: boolean
): UseWarmSessionResult {
  const [initData, setInitData] = useState<InitData | null>(null)

  // Refs for cross-render coordination
  const creationPromiseRef = useRef<Promise<string> | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const promotedRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)

  // Create phantom session and connect WebSocket
  useEffect(() => {
    if (!enabled) {
      // Reset state when disabled (e.g., when a session becomes active)
      creationPromiseRef.current = null
      sessionIdRef.current = null
      return
    }

    let cancelled = false
    promotedRef.current = false
    setInitData(null)

    const promise = (async (): Promise<string> => {
      const response = await api.post('/api/claude/sessions', {
        workingDir,
        permissionMode,
        phantom: true,
      })

      if (!response.ok) {
        throw new Error(`Failed to create warm session: ${response.status}`)
      }

      const session = await response.json()
      const id = session.id as string

      if (cancelled) {
        // Effect was cleaned up while we were creating — delete the session
        api.delete(`/api/claude/sessions/${id}`).catch(() => {})
        throw new Error('Warm session creation cancelled')
      }

      sessionIdRef.current = id

      // Connect WebSocket to receive the system:init message
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${protocol}//${window.location.host}/api/claude/sessions/${id}/subscribe`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'system' && data.subtype === 'init') {
            setInitData({
              session_id: data.session_id ?? data.sessionId,
              model: data.model,
              claude_code_version: data.claude_code_version ?? data.claudeCodeVersion,
              tools: data.tools,
              agents: data.agents,
              skills: data.skills,
              slash_commands: data.slash_commands ?? data.slashCommands,
              mcp_servers: data.mcp_servers ?? data.mcpServers,
              plugins: data.plugins,
              cwd: data.cwd,
              permissionMode: data.permissionMode ?? data.permission_mode,
              apiKeySource: data.apiKeySource ?? data.api_key_source,
              output_style: data.output_style ?? data.outputStyle,
            })
            // Got what we need — close the WebSocket. ChatInterface will open its own
            // when the session is promoted, and will get init in the burst.
            ws.close()
            wsRef.current = null
          }
        } catch {
          // Ignore parse errors for non-init messages (session_info, etc.)
        }
      }

      ws.onerror = () => {
        // WebSocket errors are non-fatal — slash commands will just fall back to builtins
      }

      return id
    })()

    creationPromiseRef.current = promise

    // Cleanup: close WebSocket and delete phantom session (unless promoted)
    return () => {
      cancelled = true

      // Close WebSocket if still open
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }

      // Delete phantom session unless it was promoted
      if (sessionIdRef.current && !promotedRef.current) {
        const idToDelete = sessionIdRef.current
        api.delete(`/api/claude/sessions/${idToDelete}`).catch(() => {
          // 404 is expected if the session already died — ignore all errors
        })
      }

      sessionIdRef.current = null
      creationPromiseRef.current = null
    }
  }, [workingDir, permissionMode, enabled])

  const getSessionId = useCallback(async (): Promise<string> => {
    if (!creationPromiseRef.current) {
      throw new Error('No warm session available')
    }
    return creationPromiseRef.current
  }, [])

  const promote = useCallback(async (title: string): Promise<PromotedSession> => {
    const sessionId = await getSessionId()

    // Mark as promoted BEFORE the API call to prevent cleanup race
    promotedRef.current = true

    const response = await api.post(`/api/claude/sessions/${sessionId}/promote`, { title })
    if (!response.ok) {
      // Revert promotion flag on failure so cleanup can still delete it
      promotedRef.current = false
      throw new Error(`Failed to promote session: ${response.status}`)
    }

    return await response.json()
  }, [getSessionId])

  return { initData, getSessionId, promote }
}
