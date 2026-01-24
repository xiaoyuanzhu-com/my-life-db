import { createHighlighter, type Highlighter } from 'shiki'
import { marked } from 'marked'
import mermaid from 'mermaid'

let highlighter: Highlighter | null = null
let loading: Promise<Highlighter> | null = null
let mermaidInitialized = false

// Placeholder pattern for mermaid blocks
const MERMAID_PLACEHOLDER_PREFIX = '___MERMAID_BLOCK_'
const MERMAID_PLACEHOLDER_SUFFIX = '___'
const MERMAID_PLACEHOLDER_REGEX = new RegExp(
  `${MERMAID_PLACEHOLDER_PREFIX}(\\d+)${MERMAID_PLACEHOLDER_SUFFIX}`,
  'g'
)

function initMermaid() {
  if (mermaidInitialized) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
  })
  mermaidInitialized = true
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

export async function parseMarkdown(content: string): Promise<string> {
  await getHighlighter()

  // Reset mermaid blocks for this parse
  mermaidBlocks = []

  // Parse markdown (mermaid blocks become placeholders)
  let html = marked.parse(content) as string

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
