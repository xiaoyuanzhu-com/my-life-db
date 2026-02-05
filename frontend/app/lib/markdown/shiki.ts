import { createHighlighter, type Highlighter } from 'shiki'

let highlighter: Highlighter | null = null
let loading: Promise<Highlighter> | null = null

export const LIGHT_THEME = 'github-light'
export const DARK_THEME = 'github-dark'

// Track loaded languages to avoid redundant checks
const loadedLanguages = new Set<string>()

export function isLanguageLoaded(lang: string): boolean {
  return loadedLanguages.has(lang)
}

export function markLanguageLoaded(lang: string): void {
  loadedLanguages.add(lang)
}

export async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter

  if (!loading) {
    loading = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: [], // Load languages on demand
    }).then((h) => {
      highlighter = h
      return h
    })
  }

  return loading
}

/**
 * Highlight code with Shiki, loading the language if needed.
 * Returns HTML string with syntax highlighting.
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter()

  // Load language if not already loaded
  if (!loadedLanguages.has(lang) && lang !== 'text') {
    try {
      await hl.loadLanguage(lang as Parameters<typeof hl.loadLanguage>[0])
      loadedLanguages.add(lang)
    } catch {
      // Language not supported - mark as loaded to avoid retrying
      loadedLanguages.add(lang)
    }
  }

  try {
    return hl.codeToHtml(code, {
      lang,
      themes: {
        light: LIGHT_THEME,
        dark: DARK_THEME,
      },
      defaultColor: false,
    })
  } catch {
    // Fallback to escaped plain text
    return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// Extract all language identifiers from markdown code blocks
export function extractLanguages(content: string): string[] {
  const langs = new Set<string>()
  const codeBlockRegex = /```(\w+)/g
  let match
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const lang = match[1]
    if (lang && lang !== 'mermaid' && lang !== 'html' && lang !== 'text') {
      langs.add(lang)
    }
  }
  return Array.from(langs)
}

// Load languages that aren't already loaded
export async function loadLanguages(hl: Highlighter, langs: string[]): Promise<void> {
  const toLoad = langs.filter((lang) => !loadedLanguages.has(lang))
  if (toLoad.length === 0) return

  await Promise.all(
    toLoad.map(async (lang) => {
      try {
        await hl.loadLanguage(lang as Parameters<typeof hl.loadLanguage>[0])
        loadedLanguages.add(lang)
      } catch {
        // Language not supported - mark as loaded to avoid retrying
        loadedLanguages.add(lang)
      }
    })
  )
}
