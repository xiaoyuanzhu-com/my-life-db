import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface ClaudeTerminalProps {
  sessionId: string
}

export function ClaudeTerminal({ sessionId }: ClaudeTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const disposableRef = useRef<{ dispose: () => void } | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')

  useEffect(() => {
    if (!terminalRef.current) return

    // Fixed terminal size - backend PTY will always be 80x24
    const COLS = 80
    const ROWS = 24

    // Calculate font size to fit container width
    const calculateFontSize = () => {
      const container = terminalRef.current
      if (!container) return 14

      const containerWidth = container.clientWidth
      // Character width is roughly 0.6 * font size for monospace fonts
      // Add some padding (subtract 20px for scrollbar/padding)
      const fontSize = Math.floor((containerWidth - 20) / (COLS * 0.6))

      // Clamp between reasonable values
      return Math.max(8, Math.min(fontSize, 16))
    }

    const fontSize = calculateFontSize()

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#000000',
        foreground: '#ffffff',
      },
      scrollback: 1000,
      // Fixed size - will match backend PTY
      rows: ROWS,
      cols: COLS,
    })

    const webLinksAddon = new WebLinksAddon()
    terminal.loadAddon(webLinksAddon)

    terminal.open(terminalRef.current)

    terminalInstRef.current = terminal

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
        const newFontSize = calculateFontSize()
        terminal.options.fontSize = newFontSize
        // Force terminal to refresh with new font size
        terminal.refresh(0, terminal.rows - 1)
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
    }
  }, [sessionId])

  return (
    <div className="relative h-full w-full">
      {/* Status indicator */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-2 rounded-md bg-background/80 px-2 py-1 text-xs md:right-4 md:top-4 md:px-3 md:text-sm backdrop-blur">
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

      {/* Terminal container */}
      <div ref={terminalRef} className="h-full w-full" />
    </div>
  )
}
