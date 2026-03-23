/**
 * useDraftPersistence — persists composer draft text to localStorage.
 *
 * Keyed by sessionId (or 'new-session' for the pre-session empty state).
 * Call `clearDraft()` after a message is confirmed sent.
 */
import { useState, useEffect, useCallback } from "react"

export function useDraftPersistence(sessionId: string | undefined) {
  const storageKey = sessionId ? `agent-input:${sessionId}` : "agent-input:new-session"

  // Load initial draft from localStorage
  const [content, setContent] = useState(() => {
    if (typeof window === "undefined") return ""
    return localStorage.getItem(storageKey) || ""
  })

  // Save to localStorage on changes (debounced via effect)
  useEffect(() => {
    if (content) {
      localStorage.setItem(storageKey, content)
    } else {
      localStorage.removeItem(storageKey)
    }
  }, [content, storageKey])

  // Clear draft (after send confirmed)
  const clearDraft = useCallback(() => {
    localStorage.removeItem(storageKey)
    setContent("")
  }, [storageKey])

  return { content, setContent, clearDraft }
}
