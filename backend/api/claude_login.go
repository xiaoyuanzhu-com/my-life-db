package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"

	"github.com/coder/websocket"
	"github.com/creack/pty"
	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ClaudeAuthStatus returns the cached Claude CLI auth status
func (h *Handlers) ClaudeAuthStatus(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"loggedIn": h.server.ClaudeLoggedIn(),
	})
}

// ClaudeLoginWebSocket spawns `claude auth login` in a PTY and pipes I/O over WebSocket.
// The PTY is killed when the WebSocket closes. Only `claude auth login` runs — no shell access.
func (h *Handlers) ClaudeLoginWebSocket(c *gin.Context) {
	// Get the underlying http.ResponseWriter from Gin's wrapper.
	// Middleware (e.g. gzip) wraps c.Writer, breaking websocket.Accept's Hijack().
	var w http.ResponseWriter = c.Writer
	if unwrapper, ok := c.Writer.(interface{ Unwrap() http.ResponseWriter }); ok {
		w = unwrapper.Unwrap()
	}

	conn, err := websocket.Accept(w, c.Request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Error().Err(err).Msg("claude login: websocket accept failed")
		return
	}

	// Abort gin context to prevent middleware from writing to hijacked connection
	c.Abort()

	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()

	// Monitor server shutdown
	go func() {
		select {
		case <-h.server.ShutdownContext().Done():
			cancel()
		case <-ctx.Done():
		}
	}()

	// Spawn `claude auth login` in a PTY with an explicit window size.
	// Claude Code uses Ink (React for CLI) which reads terminal dimensions;
	// without a proper size, the TUI may fail to render or accept input.
	cmd := exec.Command("claude", "auth", "login")
	cmd.Env = append(cmd.Environ(), "TERM=xterm-256color")

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		log.Error().Err(err).Msg("claude login: failed to start pty")
		conn.Close(websocket.StatusInternalError, "failed to start login process")
		return
	}
	defer ptmx.Close()

	done := make(chan struct{})

	// PTY → WebSocket
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if err != nil {
				return
			}
			if err := conn.Write(ctx, websocket.MessageBinary, buf[:n]); err != nil {
				return
			}
		}
	}()

	// WebSocket → PTY
	// Binary messages are terminal input; text messages are control (e.g. resize).
	go func() {
		for {
			msgType, data, err := conn.Read(ctx)
			if err != nil {
				// WebSocket closed — kill the process
				cmd.Process.Kill()
				return
			}

			// Text message = control command (resize)
			if msgType == websocket.MessageText {
				var msg struct {
					Type string `json:"type"`
					Cols uint16 `json:"cols"`
					Rows uint16 `json:"rows"`
				}
				if err := json.Unmarshal(data, &msg); err == nil && msg.Type == "resize" {
					if err := pty.Setsize(ptmx, &pty.Winsize{Rows: msg.Rows, Cols: msg.Cols}); err != nil {
						log.Debug().Err(err).Msg("claude login: pty resize failed")
					} else {
						log.Debug().Uint16("cols", msg.Cols).Uint16("rows", msg.Rows).Msg("claude login: pty resized")
					}
				}
				continue
			}

			// Binary message = terminal input
			if _, err := ptmx.Write(data); err != nil {
				log.Debug().Err(err).Msg("claude login: pty write failed")
				return
			}
		}
	}()

	// Wait for process to exit
	<-done
	exitErr := cmd.Wait()

	if exitErr == nil {
		// Login succeeded — update cached status
		h.server.SetClaudeLoggedIn(true)
		conn.Close(websocket.StatusNormalClosure, "login successful")
	} else {
		conn.Close(websocket.StatusNormalClosure, "login process exited")
	}
}
