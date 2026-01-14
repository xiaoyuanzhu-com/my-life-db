import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
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
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [inputText, setInputText] = useState('')
  const [isMobile, setIsMobile] = useState(false)

  // Detect mobile on mount and resize
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768)
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Send raw bytes to terminal
  const sendToTerminal = (text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return
    }

    const encoder = new TextEncoder()
    const uint8Array = encoder.encode(text)
    wsRef.current.send(uint8Array)

    // Echo to terminal display
    if (terminalInstRef.current) {
      terminalInstRef.current.write(text)
    }
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
    if (!terminalRef.current?.parentElement) return

    // Calculate font size to fit 80 cols in available width
    // charWidth ≈ fontSize * 0.6 (monospace aspect ratio)
    // fontSize = (containerWidth * margin) / cols / aspectRatio
    const containerWidth = isMobile ? window.innerWidth : terminalRef.current.parentElement.offsetWidth || 800
    const fontSize = isMobile
      ? Math.max(6, (containerWidth * 0.85) / 80 / 0.6)  // 85% of width, min 6px
      : 14

    // Calculate rows based on available height
    // Approximate line height = fontSize * 1.2 (with line spacing)
    const containerHeight = terminalRef.current.parentElement.offsetHeight || (isMobile ? 400 : 600)
    const lineHeight = fontSize * 1.2
    const calculatedRows = Math.floor(containerHeight / lineHeight)
    const rows = Math.max(24, Math.min(calculatedRows, 100))  // Min 24, max 100

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

    console.log('Terminal initialized: 80 cols x', rows, 'rows, fontSize:', fontSize)

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

    // Handle window resize with debouncing - recalculate font size and rows
    let resizeTimeout: number | undefined

    const handleResize = () => {
      clearTimeout(resizeTimeout)
      resizeTimeout = window.setTimeout(() => {
        try {
          const newIsMobile = window.innerWidth < 768
          const containerWidth = newIsMobile ? window.innerWidth : terminalRef.current?.parentElement?.offsetWidth || 800
          const newFontSize = newIsMobile
            ? Math.max(6, (containerWidth * 0.85) / 80 / 0.6)
            : 14

          // Recalculate rows based on new height
          const containerHeight = terminalRef.current?.parentElement?.offsetHeight || (newIsMobile ? 400 : 600)
          const lineHeight = newFontSize * 1.2
          const calculatedRows = Math.floor(containerHeight / lineHeight)
          const newRows = Math.max(24, Math.min(calculatedRows, 100))

          terminal.options.fontSize = newFontSize
          terminal.resize(80, newRows)
          console.log('Terminal resized: 80 cols x', newRows, 'rows, fontSize:', newFontSize, 'px')
        } catch (e) {
          console.warn('Resize failed:', e)
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
    }
  }, [sessionId, isMobile])

  return (
    <div
      className="relative h-full w-full flex flex-col"
      style={{
        // Prevent pull-to-refresh on mobile
        overscrollBehavior: 'contain',
        // Add padding on mobile to avoid FABs (120px for 2 FABs + gaps + input box)
        paddingBottom: isMobile ? '120px' : 0,
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

      {/* Terminal container - fixed 80 cols, scrollable if needed */}
      <div
        className="flex-1 overflow-auto"
        style={{
          // Enable smooth scrolling on mobile
          WebkitOverflowScrolling: 'touch',
          // Disable touch-action to allow native scrolling
          touchAction: 'auto',
        }}
      >
        <div ref={terminalRef} className="min-h-full" />
      </div>

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
