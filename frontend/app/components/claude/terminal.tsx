import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// Inject CSS for better mobile support
const style = document.createElement('style')
style.textContent = `
  .xterm-viewport {
    /* Enable smooth scrolling on mobile */
    -webkit-overflow-scrolling: touch !important;
    overscroll-behavior: contain !important;
  }

  .xterm-helper-textarea {
    /* Ensure textarea is accessible for mobile keyboard */
    position: absolute !important;
    opacity: 0;
    pointer-events: none;
  }
`
if (!document.querySelector('style[data-xterm-mobile]')) {
  style.setAttribute('data-xterm-mobile', 'true')
  document.head.appendChild(style)
}

interface ClaudeTerminalProps {
  sessionId: string
}

export function ClaudeTerminal({ sessionId }: ClaudeTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const disposableRef = useRef<{ dispose: () => void } | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')

  useEffect(() => {
    if (!terminalRef.current) return

    // Use a responsive font size
    const isMobile = window.innerWidth < 768
    const fontSize = isMobile ? 10 : 14

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#000000',
        foreground: '#ffffff',
      },
      scrollback: 10000,
      convertEol: true,
      // Mobile-specific: disable predictive text features
      ...(isMobile && {
        screenReaderMode: false,
      }),
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)

    terminal.open(terminalRef.current)

    terminalInstRef.current = terminal
    fitAddonRef.current = fitAddon

    // Fit terminal to container
    setTimeout(() => {
      try {
        fitAddon.fit()
        console.log('Terminal fitted:', terminal.cols, 'cols x', terminal.rows, 'rows')
      } catch (e) {
        console.warn('Fit failed:', e)
      }
    }, 100)

    // Mobile: Add touch handler to focus the hidden textarea
    // This is necessary because mobile browsers require user interaction to show keyboard
    const handleTouch = () => {
      // Find the hidden textarea that xterm.js creates
      const textarea = terminalRef.current?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      if (textarea) {
        // Focus it to bring up the mobile keyboard
        textarea.focus()
        console.log('Focused xterm-helper-textarea')
      }
    }

    if (isMobile && terminalRef.current) {
      terminalRef.current.addEventListener('touchstart', handleTouch, { passive: true })
    }

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/claude/sessions/${sessionId}/ws`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      setStatus('connected')
      terminal.write('\r\n\x1b[32mConnected to Claude Code session\x1b[0m\r\n\r\n')
    }

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const uint8Array = new Uint8Array(event.data)
        terminal.write(uint8Array)
      }
    }

    ws.onerror = (error) => {
      console.error('WebSocket error:', error)
      setStatus('disconnected')
      terminal.write('\r\n\x1b[31mWebSocket error\x1b[0m\r\n')
    }

    ws.onclose = () => {
      setStatus('disconnected')
      terminal.write('\r\n\x1b[33mDisconnected from session\x1b[0m\r\n')
    }

    // Send terminal input to WebSocket
    const disposable = terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        // Convert string to Uint8Array for binary message
        const encoder = new TextEncoder()
        const uint8Array = encoder.encode(data)
        ws.send(uint8Array)
      }
    })

    disposableRef.current = disposable

    // Handle window resize with debouncing
    let resizeTimeout: number | undefined

    const handleResize = () => {
      clearTimeout(resizeTimeout)
      resizeTimeout = window.setTimeout(() => {
        try {
          fitAddon.fit()
          console.log('Terminal resized:', terminal.cols, 'cols x', terminal.rows, 'rows')
        } catch (e) {
          console.warn('Resize fit failed:', e)
        }
      }, 150)
    }

    window.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleResize)

    // Cleanup
    return () => {
      clearTimeout(resizeTimeout)

      if (disposableRef.current) {
        disposableRef.current.dispose()
      }

      terminal.dispose()

      // Close WebSocket gracefully - handle all states
      const ws = wsRef.current
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        ws.close()
      }

      window.removeEventListener('resize', handleResize)
      window.removeEventListener('orientationchange', handleResize)

      // Remove mobile touch listener
      if (isMobile && terminalRef.current) {
        terminalRef.current.removeEventListener('touchstart', handleTouch)
      }
    }
  }, [sessionId])

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{
        // Prevent pull-to-refresh on mobile
        overscrollBehavior: 'contain',
        touchAction: 'pan-y pinch-zoom',
      }}
    >
      {/* Status indicator */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-2 rounded-md bg-background/80 px-2 py-1 text-xs md:right-4 md:top-4 md:px-3 md:text-sm backdrop-blur pointer-events-none">
        <div
          className={`h-2 w-2 rounded-full ${
            status === 'connected'
              ? 'bg-green-500'
              : status === 'connecting'
                ? 'bg-yellow-500 animate-pulse'
                : 'bg-red-500'
          }`}
        />
        <span className="capitalize text-foreground">{status}</span>
      </div>

      {/* Terminal container - FitAddon will size it to fill the space */}
      <div
        ref={terminalRef}
        className="h-full w-full"
      />
    </div>
  )
}
