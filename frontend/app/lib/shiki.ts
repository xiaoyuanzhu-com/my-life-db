import { createHighlighter, type Highlighter } from 'shiki'
import { marked } from 'marked'
import mermaid from 'mermaid'

let highlighter: Highlighter | null = null
let loading: Promise<Highlighter> | null = null
let mermaidTheme: 'default' | 'dark' | null = null

// Placeholder pattern for mermaid blocks
const MERMAID_PLACEHOLDER_PREFIX = '___MERMAID_BLOCK_'
const MERMAID_PLACEHOLDER_SUFFIX = '___'
const MERMAID_PLACEHOLDER_REGEX = new RegExp(
  `${MERMAID_PLACEHOLDER_PREFIX}(\\d+)${MERMAID_PLACEHOLDER_SUFFIX}`,
  'g'
)

// Placeholder pattern for HTML preview blocks
const HTML_PREVIEW_PLACEHOLDER_PREFIX = '___HTML_PREVIEW_BLOCK_'
const HTML_PREVIEW_PLACEHOLDER_SUFFIX = '___'
const HTML_PREVIEW_PLACEHOLDER_REGEX = new RegExp(
  `${HTML_PREVIEW_PLACEHOLDER_PREFIX}(\\d+)${HTML_PREVIEW_PLACEHOLDER_SUFFIX}`,
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

const LIGHT_THEME = 'github-light'
const DARK_THEME = 'github-dark'

const PRELOADED_LANGS = [
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'python',
  'bash',
  'shell',
  'json',
  'go',
  'html',
  'css',
  'markdown',
  'yaml',
  'sql',
  'rust',
  'c',
  'cpp',
]

export async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter

  if (!loading) {
    loading = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: PRELOADED_LANGS,
    }).then((h) => {
      highlighter = h
      configureMarked(h)
      return h
    })
  }

  return loading
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// Store mermaid blocks during parsing, render after
let mermaidBlocks: string[] = []

// Store HTML preview blocks during parsing
let htmlPreviewBlocks: string[] = []

function configureMarked(hl: Highlighter) {
  marked.use({
    breaks: true, // Convert \n to <br>
    gfm: true, // GitHub Flavored Markdown
    renderer: {
      code({ text, lang }) {
        // Handle mermaid blocks specially
        if (lang === 'mermaid') {
          const index = mermaidBlocks.length
          mermaidBlocks.push(text)
          return `${MERMAID_PLACEHOLDER_PREFIX}${index}${MERMAID_PLACEHOLDER_SUFFIX}`
        }

        // Handle HTML blocks - render as live preview
        if (lang === 'html') {
          const index = htmlPreviewBlocks.length
          htmlPreviewBlocks.push(text)
          return `${HTML_PREVIEW_PLACEHOLDER_PREFIX}${index}${HTML_PREVIEW_PLACEHOLDER_SUFFIX}`
        }

        const language = lang || 'text'
        try {
          return hl.codeToHtml(text, {
            lang: language,
            themes: {
              light: LIGHT_THEME,
              dark: DARK_THEME,
            },
            defaultColor: false, // Use CSS variables, no default
          })
        } catch {
          // Unknown language - fall back to plain code block
          return `<pre class="shiki"><code>${escapeHtml(text)}</code></pre>`
        }
      },
    },
  })
}

let mermaidIdCounter = 0

async function renderMermaidBlock(code: string): Promise<string> {
  initMermaid()
  try {
    const id = `mermaid-${mermaidIdCounter++}`
    const { svg } = await mermaid.render(id, code)
    return `<div class="mermaid-diagram">${svg}</div>`
  } catch (error) {
    // On error, show the code with error message
    const errorMsg = error instanceof Error ? error.message : 'Failed to render diagram'
    return `<div class="mermaid-error"><pre><code>${escapeHtml(code)}</code></pre><p class="text-destructive text-sm">${escapeHtml(errorMsg)}</p></div>`
  }
}

function renderHtmlPreviewBlock(code: string): string {
  const escapedHtml = code
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
  return `<div class="html-preview-container"><iframe srcdoc="${escapedHtml}" sandbox="allow-scripts" class="html-preview-iframe"></iframe></div>`
}

export async function parseMarkdown(content: string): Promise<string> {
  await getHighlighter()

  // Reset blocks for this parse
  mermaidBlocks = []
  htmlPreviewBlocks = []

  // Parse markdown (mermaid/html-preview blocks become placeholders)
  let html = marked.parse(content) as string

  // Replace HTML preview placeholders (sync, no async needed)
  if (htmlPreviewBlocks.length > 0) {
    html = html.replace(HTML_PREVIEW_PLACEHOLDER_REGEX, (_, index) => {
      return renderHtmlPreviewBlock(htmlPreviewBlocks[parseInt(index, 10)] || '')
    })
  }

  // If no mermaid blocks, return as-is
  if (mermaidBlocks.length === 0) {
    return html
  }

  // Render all mermaid blocks in parallel
  const renderedMermaids = await Promise.all(
    mermaidBlocks.map((code) => renderMermaidBlock(code))
  )

  // Replace placeholders with rendered SVGs
  html = html.replace(MERMAID_PLACEHOLDER_REGEX, (_, index) => {
    return renderedMermaids[parseInt(index, 10)] || ''
  })

  return html
}
