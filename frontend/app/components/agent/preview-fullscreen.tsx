/**
 * PreviewFullscreen — full-viewport preview overlay for HTML content.
 *
 * Renders as a portal to document.body with:
 * - Full-viewport sandboxed iframe
 * - Glassmorphism close button (top-right)
 * - Escape key to close
 * - Body scroll locked while open
 */
import { useEffect, useCallback } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"

interface PreviewFullscreenProps {
  /** HTML content to render in the iframe */
  html: string
  /** Called when the user closes the overlay */
  onClose: () => void
}

export function PreviewFullscreen({ html, onClose }: PreviewFullscreenProps) {
  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  // Escape key to close
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    },
    [onClose]
  )

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleKeyDown])

  // Build the iframe srcdoc with an escape listener inside
  const srcdoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; }
  </style>
</head>
<body>
  ${html}
  <script>
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        window.parent.postMessage({ type: 'preview-close' }, '*');
      }
    });
  </script>
</body>
</html>`

  // Listen for close message from iframe
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === "preview-close") {
        onClose()
      }
    }
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [onClose])

  return createPortal(
    <div className="preview-fullscreen-overlay">
      <iframe
        className="preview-fullscreen-iframe"
        srcDoc={srcdoc}
        sandbox="allow-scripts"
        title="Preview fullscreen"
      />
      <button
        type="button"
        className="preview-fullscreen-collapse"
        onClick={onClose}
        title="Close preview"
      >
        <X className="h-5 w-5" />
      </button>
    </div>,
    document.body
  )
}
