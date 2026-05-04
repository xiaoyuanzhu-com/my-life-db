/**
 * MarkdownContent — renders markdown text as HTML.
 *
 * Uses `marked` (already in the project) to parse markdown to HTML,
 * then renders via dangerouslySetInnerHTML with Tailwind prose-like styles.
 */
import { useMemo } from "react"
import { marked, type MarkedOptions, Renderer } from "marked"
import { useMarkdownImageLightbox } from "~/hooks/use-markdown-image-lightbox"

interface MarkdownContentProps {
  text: string
  className?: string
}

// Escape raw text for safe insertion into HTML
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// Configure marked for safe, simple rendering
const renderer = new Renderer()

// Open links in new tab
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : ""
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer" class="underline text-primary hover:text-primary/80">${text}</a>`
}

// Add styling to code blocks; render html blocks as live iframe previews
renderer.code = ({ text, lang }) => {
  // HTML blocks: render as sandboxed iframe preview
  if (lang === "html") {
    const srcdoc = text.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    return (
      '<div class="html-preview-container my-2 rounded-md border border-border overflow-hidden">' +
      '<div class="flex items-center justify-between px-3 py-1 border-b border-border">' +
      '<span class="text-[10px] uppercase tracking-wide text-muted-foreground">html preview</span>' +
      "</div>" +
      `<iframe srcdoc="${srcdoc}" sandbox="allow-scripts allow-same-origin" class="w-full bg-white" style="height:60vh;border:none;"></iframe>` +
      "</div>"
    )
  }

  const escaped = escapeHtml(text)
  const langClass = lang ? ` language-${lang}` : ""
  const langLabel = lang ? `<div class="text-[10px] uppercase tracking-wide text-muted-foreground px-3 py-1 border-b border-border">${lang}</div>` : ""
  return `${langLabel}<pre class="overflow-x-auto rounded-md bg-muted/50 border border-border px-3 py-2 my-2"><code class="text-[12px] leading-relaxed font-mono${langClass}">${escaped}</code></pre>`
}

// Inline code styling
renderer.codespan = ({ text }) => {
  return `<code class="rounded bg-muted px-1.5 py-0.5 text-[12px] font-mono">${text}</code>`
}

// Use synchronous mode (no async: true) so parse returns string
const markedOptions: MarkedOptions = {
  renderer,
  gfm: true,
  breaks: true,
}

export function MarkdownContent({ text, className = "" }: MarkdownContentProps) {
  const html = useMemo(() => {
    try {
      // marked.parse is sync when async option is not set
      const result = marked.parse(text, markedOptions)
      return result as string
    } catch {
      // Fallback to plain text on parse error
      return `<p>${text}</p>`
    }
  }, [text])

  const { containerRef, lightboxNode } = useMarkdownImageLightbox<HTMLDivElement>()

  return (
    <>
      <div
        ref={containerRef}
        className={`markdown-content text-sm break-words ${className}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {lightboxNode}
    </>
  )
}

/**
 * Minimal scoped styles for markdown rendering.
 * Uses Tailwind's @apply where possible, inline styles otherwise.
 * Add this CSS to your globals or a scoped stylesheet:
 *
 * .markdown-content p { margin: 0.25em 0; }
 * .markdown-content h1, .markdown-content h2, .markdown-content h3 { font-weight: 600; margin: 0.75em 0 0.25em; }
 * .markdown-content h1 { font-size: 1.25em; }
 * .markdown-content h2 { font-size: 1.125em; }
 * .markdown-content h3 { font-size: 1em; }
 * .markdown-content ul, .markdown-content ol { padding-left: 1.5em; margin: 0.25em 0; }
 * .markdown-content li { margin: 0.125em 0; }
 * .markdown-content blockquote { border-left: 2px solid; padding-left: 0.75em; margin: 0.5em 0; opacity: 0.8; }
 * .markdown-content table { border-collapse: collapse; margin: 0.5em 0; }
 * .markdown-content th, .markdown-content td { border: 1px solid; padding: 0.25em 0.5em; text-align: left; }
 * .markdown-content hr { margin: 0.75em 0; }
 */
