package api

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
)

// NotificationStream handles GET /api/notifications/stream (SSE)
func (h *Handlers) NotificationStream(c *gin.Context) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no") // Disable nginx buffering

	// Subscribe to notifications
	events, unsubscribe := h.server.Notifications().Subscribe()
	defer unsubscribe()

	// Send initial connected event
	sendSSEEventGin(c, notifications.Event{
		Type:      notifications.EventConnected,
		Timestamp: time.Now().UnixMilli(),
	})
	c.Writer.Flush()

	log.Debug().Msg("client connected to notification stream")

	// Heartbeat ticker
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	// Stream events - respond to either:
	// 1. Server shutdown context (graceful termination)
	// 2. Client disconnection (request context done)
	// 3. Events channel closed (notification service shutdown)
	for {
		select {
		case <-h.server.ShutdownContext().Done():
			log.Debug().Msg("server shutdown, closing SSE stream")
			return

		case event, ok := <-events:
			if !ok {
				return
			}
			sendSSEEventGin(c, event)
			c.Writer.Flush()

		case <-ticker.C:
			// Send heartbeat comment
			fmt.Fprintf(c.Writer, ": heartbeat\n\n")
			c.Writer.Flush()

		case <-c.Request.Context().Done():
			log.Debug().Msg("client disconnected from notification stream")
			return
		}
	}
}

func sendSSEEventGin(c *gin.Context, event notifications.Event) {
	data, err := json.Marshal(event)
	if err != nil {
		log.Error().Err(err).Msg("failed to marshal event")
		return
	}
	fmt.Fprintf(c.Writer, "data: %s\n\n", data)
}
