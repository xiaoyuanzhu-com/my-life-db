import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

// No custom CSS needed - use xterm.js's built-in scrolling

interface ClaudeTerminalProps {
  sessionId: string
}

export function ClaudeTerminal({ sessionId }: ClaudeTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const disposableRef = useRef<{ dispose: () => void } | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [inputText, setInputText] = useState('')
  const [isMobile, setIsMobile] = useState(false)
  const reconnectTimeoutRef = useRef<number | undefined>(undefined)
  const reconnectAttemptsRef = useRef(0)
  const shouldReconnectRef = useRef(true)

  // Detect mobile on mount and resize
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768)
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Connect to WebSocket with automatic reconnection
  const connectWebSocket = (terminal: Terminal) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/claude/sessions/${sessionId}/ws`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      setStatus('connected')
      reconnectAttemptsRef.current = 0
      terminal.write('\r\n\x1b[32mConnected to Claude Code session\x1b[0m\r\n\r\n')
    }

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const uint8Array = new Uint8Array(event.data)
        terminal.write(uint8Array)
      }
    }

    ws.onerror = () => {
      setStatus('disconnected')
      terminal.write('\r\n\x1b[31mConnection error\x1b[0m\r\n')
    }

    ws.onclose = () => {
      setStatus('disconnected')

      // Attempt to reconnect if we should and the component is still mounted
      if (shouldReconnectRef.current) {
        const attempts = reconnectAttemptsRef.current
        // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
        const delay = Math.min(1000 * Math.pow(2, attempts), 30000)

        reconnectAttemptsRef.current += 1
        terminal.write(`\r\n\x1b[33mDisconnected. Reconnecting in ${delay / 1000}s... (attempt ${attempts + 1})\x1b[0m\r\n`)

        reconnectTimeoutRef.current = window.setTimeout(() => {
          if (shouldReconnectRef.current && terminalInstRef.current) {
            setStatus('connecting')
            connectWebSocket(terminalInstRef.current)
          }
        }, delay)
      } else {
        terminal.write('\r\n\x1b[33mDisconnected from session\x1b[0m\r\n')
      }
    }

    // Send terminal input to WebSocket
    if (disposableRef.current) {
      disposableRef.current.dispose()
    }

    const disposable = terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        const encoder = new TextEncoder()
        const uint8Array = encoder.encode(data)
        ws.send(uint8Array)
      }
    })
    disposableRef.current = disposable
  }

  // Send raw bytes to terminal
  const sendToTerminal = (text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return
    }

    const encoder = new TextEncoder()
    const uint8Array = encoder.encode(text)
    wsRef.current.send(uint8Array)

    // Don't echo - the backend/shell will echo back via WebSocket
  }

  // Send input text to terminal
  const handleSend = () => {
    if (!inputText.trim()) {
      return
    }

    // Send the input text followed by Enter (newline)
    sendToTerminal(inputText + '\n')

    // Clear the input
    setInputText('')
  }

  // Handle special key buttons
  const handleSpecialKey = (key: 'up' | 'down' | 'enter' | 'esc' | 'backspace') => {
    const keyMap = {
      up: '\x1b[A',      // ANSI escape code for up arrow
      down: '\x1b[B',    // ANSI escape code for down arrow
      enter: '\r',       // Carriage return
      esc: '\x1b',       // Escape character
      backspace: '\x7f', // Backspace/Delete (DEL character)
    }

    sendToTerminal(keyMap[key])
  }

  // Handle Enter key in input
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSend()
    }
  }

  useEffect(() => {
    if (!terminalRef.current) return

    // Enable reconnection
    shouldReconnectRef.current = true
    reconnectAttemptsRef.current = 0

    // Calculate font size to fit 80 cols in screen width
    const containerWidth = isMobile ? window.innerWidth : 800
    const fontSize = isMobile
      ? Math.max(6, (containerWidth * 0.85) / 80 / 0.6)  // 85% of width, min 6px
      : 14

    // Calculate rows based on screen height (mobile) or use generous default (desktop)
    // Mobile: use full window height minus input box (~140px) and header if any
    // Desktop: use a generous fixed value since container will expand
    const containerHeight = isMobile
      ? window.innerHeight - 200  // 200px for input box + header + padding
      : 800  // Desktop: large default, will be constrained by CSS

    const lineHeight = fontSize * 1.2
    const calculatedRows = Math.floor(containerHeight / lineHeight)
    const rows = Math.max(24, calculatedRows)  // Min 24 rows

    const terminal = new Terminal({
      cols: 80,  // Fixed 80 columns (matches backend PTY default)
      rows,      // Calculate rows based on available height
      cursorBlink: true,
      fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#000000',
        foreground: '#ffffff',
      },
      scrollback: 10000,
      convertEol: true,
      // Mobile-specific optimizations
      ...(isMobile && {
        screenReaderMode: false,
        disableStdin: true,  // Disable keyboard input on mobile (we use custom input box)
      }),
    })

    const webLinksAddon = new WebLinksAddon()
    terminal.loadAddon(webLinksAddon)

    terminal.open(terminalRef.current)

    terminalInstRef.current = terminal

    // Connect WebSocket with auto-reconnect
    connectWebSocket(terminal)

    // Handle window resize with debouncing - recalculate font size and rows
    let resizeTimeout: number | undefined

    const handleResize = () => {
      clearTimeout(resizeTimeout)
      resizeTimeout = window.setTimeout(() => {
        try {
          const newIsMobile = window.innerWidth < 768
          const containerWidth = newIsMobile ? window.innerWidth : 800
          const newFontSize = newIsMobile
            ? Math.max(6, (containerWidth * 0.85) / 80 / 0.6)
            : 14

          // Recalculate rows based on screen height
          const containerHeight = newIsMobile
            ? window.innerHeight - 200
            : 800

          const lineHeight = newFontSize * 1.2
          const calculatedRows = Math.floor(containerHeight / lineHeight)
          const newRows = Math.max(24, calculatedRows)

          terminal.options.fontSize = newFontSize
          terminal.resize(80, newRows)
        } catch (e) {
          // Silent - resize failures are not critical
        }
      }, 150)
    }

    window.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleResize)

    // Handle visibility change (mobile tab switching, screen sleep, etc.)
    const handleVisibilityChange = () => {
      if (!document.hidden && terminalInstRef.current) {
        // Tab became visible - check if we need to reconnect
        const ws = wsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          connectWebSocket(terminalInstRef.current)
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // Cleanup
    return () => {
      clearTimeout(resizeTimeout)

      // Disable reconnection when component unmounts
      shouldReconnectRef.current = false
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }

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
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [sessionId, isMobile])

  return (
    <div
      className="relative h-full w-full flex flex-col"
      style={{
        // Prevent pull-to-refresh on mobile
        overscrollBehavior: 'contain',
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

      {/* Terminal container - xterm.js handles scrolling */}
      <div
        ref={terminalRef}
        className="flex-1"
        style={{ paddingBottom: isMobile ? '140px' : 0 }}
      />

      {/* Mobile input box - only shown on mobile devices - FIXED positioning */}
      {isMobile && (
        <div className="fixed bottom-0 left-0 right-0 flex flex-col gap-2 p-2 border-t border-border bg-background z-10">
          {/* Special keys row */}
          <div className="flex gap-2">
            <button
              onClick={() => handleSpecialKey('up')}
              disabled={status !== 'connected'}
              className="flex-1 px-2 py-2 text-sm font-medium bg-muted border border-input rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
              title="Up Arrow"
            >
              ↑
            </button>
            <button
              onClick={() => handleSpecialKey('down')}
              disabled={status !== 'connected'}
              className="flex-1 px-2 py-2 text-sm font-medium bg-muted border border-input rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
              title="Down Arrow"
            >
              ↓
            </button>
            <button
              onClick={() => handleSpecialKey('enter')}
              disabled={status !== 'connected'}
              className="flex-1 px-2 py-2 text-sm font-medium bg-muted border border-input rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
              title="Enter"
            >
              ↵
            </button>
            <button
              onClick={() => handleSpecialKey('backspace')}
              disabled={status !== 'connected'}
              className="flex-1 px-2 py-2 text-sm font-medium bg-muted border border-input rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
              title="Backspace"
            >
              ⌫
            </button>
            <button
              onClick={() => handleSpecialKey('esc')}
              disabled={status !== 'connected'}
              className="flex-1 px-2 py-2 text-sm font-medium bg-muted border border-input rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
              title="Escape"
            >
              Esc
            </button>
          </div>

          {/* Input row */}
          <div className="flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type command here..."
              className="flex-1 px-3 py-2 text-sm bg-muted border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={status !== 'connected'}
            />
            <button
              onClick={handleSend}
              disabled={status !== 'connected' || !inputText.trim()}
              className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
