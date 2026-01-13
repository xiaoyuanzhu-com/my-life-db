import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface ClaudeTerminalProps {
  sessionId: string
}

export function ClaudeTerminal({ sessionId }: ClaudeTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')

  useEffect(() => {
    if (!terminalRef.current) return

    // Create terminal
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#000000',
        foreground: '#ffffff',
      },
      rows: 30,
      cols: 120,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)

    terminal.open(terminalRef.current)
    fitAddon.fit()

    terminalInstRef.current = terminal
    fitAddonRef.current = fitAddon

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

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit()

      // Send resize event to backend
      if (ws.readyState === WebSocket.OPEN) {
        fetch(`/api/claude/sessions/${sessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        }).catch(console.error)
      }
    }

    window.addEventListener('resize', handleResize)

    // Cleanup
    return () => {
      disposable.dispose()
      terminal.dispose()
      ws.close()
      window.removeEventListener('resize', handleResize)
    }
  }, [sessionId])

  return (
    <div className="relative h-full w-full">
      {/* Status indicator */}
      <div className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-md bg-background/80 px-3 py-1 text-sm backdrop-blur">
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
      <div ref={terminalRef} className="h-full w-full p-4" />
    </div>
  )
}
