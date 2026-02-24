import { useState, useRef, useEffect, useCallback } from 'react'
import { api } from '~/lib/api'
import type { InitData } from './use-slash-commands'

export interface UseWarmSessionResult {
  /** InitData extracted from the system:init message, or null if not yet received. */
  initData: InitData | null
  /** Awaitable — resolves to session ID once creation completes. Rejects if creation failed. */
  getSessionId: () => Promise<string>
  /** Activate the warm session: set title via PATCH, mark as used so cleanup won't delete it. */
  activate: (title: string) => Promise<string>
}

/**
 * Eagerly creates a Claude session and connects a WebSocket to receive
 * the system:init message (which contains skills and slash commands).
 *
 * The session is a normal session — it stays out of listings because it has
 * no completed turns (ResultCount == 0) and no connected clients. Once the
 * user sends their first message, `activate()` sets the title via PATCH and
 * marks it so cleanup won't delete it.
 *
 * Idle session GC on the backend will eventually clean up abandoned sessions.
 *
 * Lifecycle:
 * - On mount (when enabled): creates session, connects WebSocket
 * - On workingDir/permissionMode change: tears down old session, creates new one
 * - On disable or unmount: closes WebSocket, deletes session (unless activated)
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
  const activatedRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)

  // Create session and connect WebSocket
  useEffect(() => {
    if (!enabled) {
      // Reset state when disabled (e.g., when a session becomes active)
      creationPromiseRef.current = null
      sessionIdRef.current = null
      return
    }

    let cancelled = false
    activatedRef.current = false
    setInitData(null)

    const promise = (async (): Promise<string> => {
      const response = await api.post('/api/claude/sessions', {
        workingDir,
        permissionMode,
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
            // when the session becomes active, and will get init in the burst.
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

    // Cleanup: close WebSocket and delete session (unless activated)
    return () => {
      cancelled = true

      // Close WebSocket if still open
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }

      // Delete warm session unless it was activated by user's first message
      if (sessionIdRef.current && !activatedRef.current) {
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

  const activate = useCallback(async (title: string): Promise<string> => {
    const sessionId = await getSessionId()

    // Mark as activated BEFORE the API call to prevent cleanup race
    activatedRef.current = true

    // Set title via the existing PATCH endpoint
    const response = await api.patch(`/api/claude/sessions/${sessionId}`, { title })
    if (!response.ok) {
      // Revert activation flag on failure so cleanup can still delete it
      activatedRef.current = false
      throw new Error(`Failed to activate session: ${response.status}`)
    }

    return sessionId
  }, [getSessionId])

  return { initData, getSessionId, activate }
}
