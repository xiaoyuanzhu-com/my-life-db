/**
 * Scroll debug logger — enabled at runtime via `window.__SCROLL_DEBUG__ = true`
 *
 * Prefixes:
 *   📜 = scroll events (from browser)
 *   👆 = touch/pointer events (user input)
 *   🔄 = state transitions (phase, sticky, range)
 *   📐 = measurements (scrollHeight, scrollTop, viewport)
 *   🧊 = freeze/expand decisions (virtual list)
 *   📦 = data changes (count, prepend, append)
 *   ⚙️ = programmatic actions (scrollToBottom, stickIfNeeded)
 */


export function scrollDebug(prefix: string, label: string, data?: Record<string, unknown>): void {
  if (data) {
    console.log(`${prefix} [${label}] – ${JSON.stringify(data)}`)
  } else {
    console.log(`${prefix} [${label}]`)
  }
}
