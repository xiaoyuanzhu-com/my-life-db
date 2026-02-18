import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface PreviewFullscreenProps {
  /** The HTML content to display in the fullscreen iframe */
  srcdoc: string
  /** Callback to close the fullscreen preview */
  onClose: () => void
}

export function PreviewFullscreen({ srcdoc, onClose }: PreviewFullscreenProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    // Lock body scroll while fullscreen is open
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prev
    }
  }, [handleKeyDown])

  return createPortal(
    <div
      className="preview-fullscreen-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Fullscreen preview"
    >
      {/* Collapse button — top right, mirrors the expand button position */}
      <button
        className="preview-fullscreen-collapse"
        onClick={(e) => {
          e.stopPropagation()
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

      {/* Fullscreen iframe — click inside should NOT close the overlay */}
      <iframe
        className="preview-fullscreen-iframe"
        srcDoc={srcdoc}
        sandbox="allow-scripts"
        title="Preview content"
        onClick={(e) => e.stopPropagation()}
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
