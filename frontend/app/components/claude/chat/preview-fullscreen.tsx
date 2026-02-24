import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface PreviewFullscreenProps {
  /** The HTML content to display in the fullscreen iframe */
  srcdoc: string
  /** Callback to close the fullscreen preview */
  onClose: () => void
}

/**
 * Inject an Escape key listener into iframe srcdoc content.
 * When Escape is pressed inside the sandboxed iframe, it sends a postMessage
 * to the parent so the fullscreen overlay can close — even though
 * sandbox="allow-scripts" prevents direct DOM access, postMessage always works.
 */
function injectEscapeHandler(srcdoc: string): string {
  const script =
    '<script>document.addEventListener("keydown",function(e){' +
    'if(e.key==="Escape")window.parent.postMessage({type:"preview-close"},"*")' +
    '});<\\/script>'
  // Prefer injecting before </body> for well-formed HTML
  if (srcdoc.includes('</body>')) {
    return srcdoc.replace('</body>', script + '</body>')
  }
  // Fallback: append at end (works for HTML fragments too)
  return srcdoc + script
}

export function PreviewFullscreen({ srcdoc, onClose }: PreviewFullscreenProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    // Parent-document Escape handler (for when iframe does NOT have focus)
    document.addEventListener('keydown', handleKeyDown)

    // Listen for Escape postMessage from inside the sandboxed iframe
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === 'preview-close') onClose()
    }
    window.addEventListener('message', handleMessage)

    // Lock body scroll while fullscreen is open
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('message', handleMessage)
      document.body.style.overflow = prev
    }
  }, [handleKeyDown])

  // True full-bleed layout: iframe fills the entire viewport, close button
  // floats above it with a gradient scrim for contrast.  Safe area offsets
  // are applied only to the button position via CSS.
  return createPortal(
    <div
      className="preview-fullscreen-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Fullscreen preview"
    >
      {/* Gradient scrim — ensures close button is visible over any content */}
      <div className="preview-fullscreen-scrim" />

      <button
        className="preview-fullscreen-collapse"
        onClick={onClose}
        onPointerDown={(e) => {
          e.preventDefault()
          onClose()
        }}
        aria-label="Collapse preview"
        title="Collapse preview"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="4 14 10 14 10 20" />
          <polyline points="20 10 14 10 14 4" />
          <line x1="14" y1="10" x2="21" y2="3" />
          <line x1="3" y1="21" x2="10" y2="14" />
        </svg>
      </button>

      <iframe
        className="preview-fullscreen-iframe"
        srcDoc={injectEscapeHandler(srcdoc)}
        sandbox="allow-scripts"
        title="Preview content"
      />
    </div>,
    document.body
  )
}

/**
 * Wraps raw SVG markup in a minimal HTML document suitable for iframe srcdoc.
 * Reads the current theme from the document to set the background color.
 */
export function wrapSvgInHtml(svgHtml: string): string {
  const isDark = document.documentElement.classList.contains('dark')
  const bg = isDark ? '#1A1A1A' : '#FFFFFF'
  return `<!DOCTYPE html>
<html>
<head>
<style>
  body {
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    background: ${bg};
    overflow: auto;
  }
  svg {
    max-width: 95vw;
    max-height: 95vh;
    width: auto;
    height: auto;
  }
</style>
</head>
<body>${svgHtml}</body>
</html>`
}
