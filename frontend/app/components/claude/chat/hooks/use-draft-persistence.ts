import { useState, useEffect, useRef, useCallback } from 'react'

function getStorageKey(sessionId: string): string {
  return `claude-input:${sessionId}`
}

export interface DraftPersistence {
  /** Current draft content */
  content: string
  /** Update draft content (auto-saves to localStorage) */
  setContent: (content: string) => void
  /** Clear draft from localStorage (call when message confirmed sent) */
  clearDraft: () => void
  /** Restore content from localStorage (call on send failure) */
  restoreDraft: () => void
  /** Get current draft from localStorage */
  getDraft: () => string | null
  /** Mark that a send is pending (prevents clearing localStorage on optimistic UI clear) */
  markPendingSend: () => void
}

/**
 * Manages draft message persistence to localStorage.
 * Handles optimistic UI clearing while preserving draft for recovery on send failure.
 */
export function useDraftPersistence(sessionId: string): DraftPersistence {
  const [content, setContentState] = useState('')

  // Track pending send state - when true, don't sync empty content to localStorage
  // This allows optimistic UI clear while preserving localStorage for recovery
  const pendingSendRef = useRef(false)

  // Restore draft from localStorage on mount or sessionId change
  useEffect(() => {
    try {
      const saved = localStorage.getItem(getStorageKey(sessionId))
      if (saved) {
        setContentState(saved)
      } else {
        setContentState('')
      }
    } catch (error) {
      console.error('[useDraftPersistence] Failed to restore draft from localStorage:', error)
      setContentState('')
    }
  }, [sessionId])

  // Save to localStorage on content change (but not during optimistic send)
  useEffect(() => {
    // During optimistic send, don't sync empty content to localStorage
    if (pendingSendRef.current && !content) {
      return
    }
    try {
      const key = getStorageKey(sessionId)
      if (content) {
        localStorage.setItem(key, content)
      } else {
        localStorage.removeItem(key)
      }
    } catch (error) {
      console.error('[useDraftPersistence] Failed to save draft to localStorage:', error)
    }
  }, [content, sessionId])

  const setContent = useCallback((newContent: string) => {
    setContentState(newContent)
  }, [])

  const clearDraft = useCallback(() => {
    try {
      pendingSendRef.current = false
      localStorage.removeItem(getStorageKey(sessionId))
    } catch (error) {
      console.error('[useDraftPersistence] Failed to clear draft:', error)
    }
  }, [sessionId])

  const restoreDraft = useCallback(() => {
    try {
      pendingSendRef.current = false
      const saved = localStorage.getItem(getStorageKey(sessionId))
      if (saved) {
        setContentState(saved)
      }
    } catch (error) {
      console.error('[useDraftPersistence] Failed to restore draft:', error)
    }
  }, [sessionId])

  const getDraft = useCallback(() => {
    try {
      return localStorage.getItem(getStorageKey(sessionId))
    } catch {
      return null
    }
  }, [sessionId])

  const markPendingSend = useCallback(() => {
    pendingSendRef.current = true
  }, [])

  return {
    content,
    setContent,
    clearDraft,
    restoreDraft,
    getDraft,
    markPendingSend,
  }
}
