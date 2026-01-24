import { createHighlighter, type Highlighter } from 'shiki'
import { marked } from 'marked'

let highlighter: Highlighter | null = null
let loading: Promise<Highlighter> | null = null

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
      themes: ['github-dark-dimmed'],
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

function configureMarked(hl: Highlighter) {
  marked.use({
    breaks: true, // Convert \n to <br>
    gfm: true, // GitHub Flavored Markdown
    renderer: {
      code({ text, lang }) {
        const language = lang || 'text'
        try {
          return hl.codeToHtml(text, {
            lang: language,
            theme: 'github-dark-dimmed',
          })
        } catch {
          // Unknown language - fall back to plain code block
          return `<pre class="shiki"><code>${escapeHtml(text)}</code></pre>`
        }
      },
    },
  })
}

export async function parseMarkdown(content: string): Promise<string> {
  await getHighlighter()
  return marked.parse(content) as string
}
