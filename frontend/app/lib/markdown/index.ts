import { marked } from 'marked'
import {
  getHighlighter,
  extractLanguages,
  loadLanguages,
  escapeHtml,
  isLanguageLoaded,
  LIGHT_THEME,
  DARK_THEME,
} from './shiki'
import {
  MERMAID_PLACEHOLDER_PREFIX,
  MERMAID_PLACEHOLDER_SUFFIX,
  MERMAID_PLACEHOLDER_REGEX,
  renderMermaidBlock,
  getMermaidLoadingHtml,
} from './mermaid'
import {
  HTML_PREVIEW_PLACEHOLDER_PREFIX,
  HTML_PREVIEW_PLACEHOLDER_SUFFIX,
  HTML_PREVIEW_PLACEHOLDER_REGEX,
  renderHtmlPreviewBlock,
  getHtmlPreviewLoadingHtml,
} from './html-preview'

// Re-export commonly used functions
export { highlightCode } from './shiki'
export { onMermaidThemeChange } from './mermaid'

// Store blocks during parsing, render after
let mermaidBlocks: string[] = []
let htmlPreviewBlocks: string[] = []

let markedConfigured = false

function configureMarked() {
  if (markedConfigured) return

  // Get highlighter synchronously if already loaded, otherwise configure will be called again
  getHighlighter().then((hl) => {
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

          // Check if language is loaded
          if (!isLanguageLoaded(language) && language !== 'text') {
            // Language not loaded yet - fall back to plain
            return `<pre class="shiki"><code>${escapeHtml(text)}</code></pre>`
          }

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
    markedConfigured = true
  })
}

// Initialize on module load
configureMarked()

function wrapTables(html: string): string {
  return html
    .replace(/<table>/g, '<div class="table-wrapper"><table>')
    .replace(/<\/table>/g, '</table></div>')
}

/**
 * Synchronous markdown parsing for streaming content.
 * Uses marked.parse() with the custom renderer but replaces special block
 * placeholders with loading UI instead of rendering them.
 * Fast enough to call on every streaming update without debouncing.
 */
export function parseMarkdownSync(content: string): string {
  // Reset blocks before parsing (they get populated by the custom renderer)
  mermaidBlocks = []
  htmlPreviewBlocks = []

  let html = marked.parse(content, { async: false, gfm: true, breaks: true }) as string

  html = wrapTables(html)

  // Replace mermaid placeholders with loading UI
  html = html.replace(MERMAID_PLACEHOLDER_REGEX, () => getMermaidLoadingHtml())

  // Replace HTML preview placeholders with loading UI
  html = html.replace(HTML_PREVIEW_PLACEHOLDER_REGEX, () => getHtmlPreviewLoadingHtml())

  return html
}

export async function parseMarkdown(content: string): Promise<string> {
  const hl = await getHighlighter()

  // Ensure marked is configured
  if (!markedConfigured) {
    configureMarked()
  }

  // Extract and load languages before parsing
  const langs = extractLanguages(content)
  await loadLanguages(hl, langs)

  // Reset blocks for this parse
  mermaidBlocks = []
  htmlPreviewBlocks = []

  // Parse markdown (mermaid/html-preview blocks become placeholders)
  let html = marked.parse(content) as string

  html = wrapTables(html)

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
  const renderedMermaids = await Promise.all(mermaidBlocks.map((code) => renderMermaidBlock(code)))

  // Replace placeholders with rendered SVGs
  html = html.replace(MERMAID_PLACEHOLDER_REGEX, (_, index) => {
    return renderedMermaids[parseInt(index, 10)] || ''
  })

  return html
}
