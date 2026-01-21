package log

import (
	"time"

	"github.com/gin-gonic/gin"
)

// ContextKeyHijacked is the key used to mark a connection as hijacked in Gin's context.
// WebSocket handlers should call MarkHijacked(c) after upgrading the connection.
const ContextKeyHijacked = "connection_hijacked"

// MarkHijacked marks the connection as hijacked in Gin's context.
// Call this in WebSocket handlers BEFORE calling websocket.Accept() to prevent
// middleware from attempting to write to the hijacked connection.
//
// Why this is needed:
// - Go's net/http doesn't provide a Hijacked() method (see golang/go#16456)
// - Calling Write(nil) to check has side effects (writes StatusOK if not hijacked)
// - c.IsAborted() is unrelated to hijacking (only tracks middleware chain abort)
// - We need a reliable way for middleware to know the connection was hijacked
func MarkHijacked(c *gin.Context) {
	c.Set(ContextKeyHijacked, true)
}

// IsHijacked checks if the connection has been marked as hijacked.
func IsHijacked(c *gin.Context) bool {
	hijacked, exists := c.Get(ContextKeyHijacked)
	return exists && hijacked.(bool)
}

// GinLogger returns a Gin middleware that logs requests using zerolog
func GinLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		raw := c.Request.URL.RawQuery

		// Process request
		c.Next()

		// Skip logging for hijacked connections (WebSocket upgrades).
		// When a WebSocket handler upgrades the connection, it gets "hijacked"
		// from the HTTP server. Any subsequent attempt to access c.Writer
		// (including c.Writer.Status()) causes Gin to call WriteHeaderNow()
		// on the hijacked connection, triggering the warning:
		// "http: response.WriteHeader on hijacked connection"
		if IsHijacked(c) {
			return
		}

		// Calculate latency
		latency := time.Since(start)

		// Get status and other info
		status := c.Writer.Status()
		method := c.Request.Method
		clientIP := c.ClientIP()
		errorMessage := c.Errors.ByType(gin.ErrorTypePrivate).String()

		// Build path with query string
		if raw != "" {
			path = path + "?" + raw
		}

		// Log based on status code
		event := Info()
		if status >= 500 {
			event = Error()
		} else if status >= 400 {
			event = Warn()
		}

		event.
			Str("method", method).
			Str("path", path).
			Int("status", status).
			Dur("latency", latency).
			Str("ip", clientIP)

		if errorMessage != "" {
			event.Str("error", errorMessage)
		}

		event.Msg("request")
	}
}
