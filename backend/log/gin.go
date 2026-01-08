package log

import (
	"time"

	"github.com/gin-gonic/gin"
)

// GinLogger returns a Gin middleware that logs requests using zerolog
func GinLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		raw := c.Request.URL.RawQuery

		// Process request
		c.Next()

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
