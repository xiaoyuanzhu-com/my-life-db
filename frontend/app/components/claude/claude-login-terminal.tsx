import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface ClaudeLoginTerminalProps {
  onLoginSuccess: () => void
}

export function ClaudeLoginTerminal({ onLoginSuccess }: ClaudeLoginTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<'connecting' | 'running' | 'success' | 'error'>('connecting')

  useEffect(() => {
    if (!terminalRef.current) return

    const term = new Terminal({
      fontSize: 14,
      fontFamily: 'JetBrains Mono, monospace',
      cursorBlink: true,
      rows: 12,
      cols: 80,
      theme: {
        background: 'transparent',
      },
      convertEol: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)

    term.open(terminalRef.current)
    fitAddon.fit()
    termRef.current = term

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/claude-login/ws`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('running')
    }

    ws.onmessage = (event) => {
      const data = event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : event.data
      term.write(data)
    }

    ws.onclose = (event) => {
      if (event.reason === 'login successful') {
        setStatus('success')
      } else {
        setStatus('error')
      }
    }

    ws.onerror = () => {
      setStatus('error')
    }

    // Terminal input → WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data))
      }
    })

    // Handle resize
    const observer = new ResizeObserver(() => {
      fitAddon.fit()
    })
    observer.observe(terminalRef.current)

    return () => {
      observer.disconnect()
      ws.close()
      term.dispose()
    }
  }, [])

  return (
    <div className="flex flex-col items-center justify-center gap-6 p-8">
      <div className="max-w-2xl w-full space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">Claude Code Login</h2>
          <p className="text-sm text-muted-foreground">
            Claude Code is not authenticated. Complete the login below to continue.
          </p>
        </div>

        <div
          ref={terminalRef}
          className="w-full rounded-lg border border-border overflow-hidden p-2"
          style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
        />

        {status === 'success' && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-green-600 dark:text-green-400">
              ✓ Login successful
            </p>
            <button
              onClick={onLoginSuccess}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Continue
            </button>
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-red-600 dark:text-red-400">
              Login process exited. Reload to try again.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
