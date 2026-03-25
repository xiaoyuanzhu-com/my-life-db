import { useState, useEffect } from 'react'

/**
 * Reactively track the offsetWidth of an anchor element using ResizeObserver.
 * Returns 0 when the ref isn't ready (caller should gate rendering on width > 0).
 */
export function useAnchorWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() => ref.current?.offsetWidth ?? 0)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Sync initial width
    setWidth(el.offsetWidth)

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Use borderBoxSize when available (more accurate), fall back to offsetWidth
        if (entry.borderBoxSize?.length) {
          setWidth(entry.borderBoxSize[0].inlineSize)
        } else {
          setWidth((entry.target as HTMLElement).offsetWidth)
        }
      }
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return width
}
