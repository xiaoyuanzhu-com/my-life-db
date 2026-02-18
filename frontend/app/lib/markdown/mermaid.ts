import mermaid from 'mermaid'
import { escapeHtml } from './shiki'

let mermaidTheme: 'default' | 'dark' | null = null
let mermaidIdCounter = 0

// Placeholder pattern for mermaid blocks
export const MERMAID_PLACEHOLDER_PREFIX = '___MERMAID_BLOCK_'
export const MERMAID_PLACEHOLDER_SUFFIX = '___'
export const MERMAID_PLACEHOLDER_REGEX = new RegExp(
  `${MERMAID_PLACEHOLDER_PREFIX}(\\d+)${MERMAID_PLACEHOLDER_SUFFIX}`,
  'g'
)

function isDarkMode(): boolean {
  if (typeof document === 'undefined') return false
  // Check for explicit .dark class on html element
  if (document.documentElement.classList.contains('dark')) return true
  // If no explicit class, check system preference (for "auto" mode)
  if (!document.documentElement.classList.contains('light')) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  return false
}

function initMermaid() {
  const theme = isDarkMode() ? 'dark' : 'default'
  // Re-initialize if theme changed
  if (mermaidTheme === theme) return
  mermaid.initialize({
    startOnLoad: false,
    theme,
    securityLevel: 'loose',
  })
  mermaidTheme = theme
}

// Theme change listener system
type ThemeChangeCallback = () => void
const themeChangeCallbacks = new Set<ThemeChangeCallback>()
let themeListenersInitialized = false

function notifyThemeChange() {
  // Reset mermaid theme so it re-initializes on next render
  mermaidTheme = null
  themeChangeCallbacks.forEach((cb) => cb())
}

function initThemeListeners() {
  if (themeListenersInitialized || typeof document === 'undefined') return
  themeListenersInitialized = true

  // Watch for class changes on <html> element
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.attributeName === 'class') {
        notifyThemeChange()
        break
      }
    }
  })
  observer.observe(document.documentElement, { attributes: true })

  // Watch for system preference changes (for "auto" mode)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', notifyThemeChange)
}

export function onMermaidThemeChange(callback: ThemeChangeCallback): () => void {
  initThemeListeners()
  themeChangeCallbacks.add(callback)
  return () => themeChangeCallbacks.delete(callback)
}

// Expand button SVG — Lucide "maximize-2" icon
const EXPAND_BTN_HTML = `<button class="preview-expand-btn" aria-label="Expand preview" title="Expand preview"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>`

export async function renderMermaidBlock(code: string): Promise<string> {
  initMermaid()
  try {
    const id = `mermaid-${mermaidIdCounter++}`
    const { svg } = await mermaid.render(id, code)
    return `<div class="mermaid-diagram">${EXPAND_BTN_HTML}${svg}</div>`
  } catch (error) {
    // On error, show the code with error message
    const errorMsg = error instanceof Error ? error.message : 'Failed to render diagram'
    return `<div class="mermaid-error"><pre><code>${escapeHtml(code)}</code></pre><p class="text-destructive text-sm">${escapeHtml(errorMsg)}</p></div>`
  }
}

export function getMermaidLoadingHtml(): string {
  return '<div class="mermaid-loading"><span class="text-muted-foreground text-sm">Rendering diagram...</span></div>'
}
