import { useState, useMemo, useCallback } from 'react'

/**
 * Shared hook for unified Enter/Return key behavior across message inputs.
 *
 * Solves three problems:
 * 1. IME composition guard — Enter to confirm a CJK character must not send
 * 2. Mobile newline — soft keyboards have no Shift key, so Enter = newline on mobile
 * 3. enterKeyHint — tells the mobile keyboard what icon to show on the Return key
 *
 * Desktop: Enter = send, Shift+Enter = newline
 * Mobile:  Return = newline, send via button only
 */
export function useMessageInputKeyboard() {
  // Track IME composition state manually for Safari compatibility.
  // Safari fires compositionend *before* keydown, so isComposing on the
  // native event may already be false when the confirming Enter arrives.
  // By deferring the reset with setTimeout(0), we keep our flag true until
  // after the keydown handler runs.
  const [isComposing, setIsComposing] = useState(false)

  const isMobile = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  }, [])

  const onCompositionStart = useCallback(() => {
    setIsComposing(true)
  }, [])

  const onCompositionEnd = useCallback(() => {
    // Delay reset so that the keydown handler (which fires after
    // compositionend in Safari) still sees isComposing === true.
    setTimeout(() => setIsComposing(false), 0)
  }, [])

  /**
   * Returns true if the Enter key should send the message.
   * Returns false if it should be treated as a newline (or ignored for IME).
   *
   * The caller is responsible for calling e.preventDefault() and triggering
   * the send when this returns true.
   */
  const shouldSend = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (e.key !== 'Enter') return false

      // Never send during IME composition (CJK input, etc.)
      if (e.nativeEvent.isComposing || isComposing) return false

      // Mobile: Return key always inserts a newline; send via button
      if (isMobile) return false

      // Desktop: Enter (without Shift) sends; Shift+Enter inserts newline
      if (e.shiftKey) return false

      return true
    },
    [isComposing, isMobile]
  )

  return {
    /** Bind to textarea's onCompositionStart */
    onCompositionStart,
    /** Bind to textarea's onCompositionEnd */
    onCompositionEnd,
    /** Call inside onKeyDown — returns true when Enter should trigger send */
    shouldSend,
    /** Value for the textarea's enterKeyHint attribute */
    enterKeyHint: (isMobile ? 'enter' : 'send') as 'enter' | 'send',
    /** Whether the current device is mobile */
    isMobile,
    /** Whether IME composition is in progress (exposed for edge cases) */
    isComposing,
  }
}
