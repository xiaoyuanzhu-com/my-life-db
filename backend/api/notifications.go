package api

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
)

var notifLogger = log.GetLogger("ApiNotifications")

// NotificationStream handles GET /api/notifications/stream (SSE)
func NotificationStream(c echo.Context) error {
	c.Response().Header().Set("Content-Type", "text/event-stream")
	c.Response().Header().Set("Cache-Control", "no-cache")
	c.Response().Header().Set("Connection", "keep-alive")
	c.Response().Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering

	// Subscribe to notifications
	events, unsubscribe := notifications.GetService().Subscribe()
	defer unsubscribe()

	// Send initial connected event
	sendSSEEvent(c, notifications.Event{
		Type:      notifications.EventConnected,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	})
	c.Response().Flush()

	notifLogger.Debug().Msg("client connected to notification stream")

	// Heartbeat ticker
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	// Stream events
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return nil
			}
			sendSSEEvent(c, event)
			c.Response().Flush()

		case <-ticker.C:
			// Send heartbeat comment
			fmt.Fprintf(c.Response(), ": heartbeat\n\n")
			c.Response().Flush()

		case <-c.Request().Context().Done():
			notifLogger.Debug().Msg("client disconnected from notification stream")
			return nil
		}
	}
}

func sendSSEEvent(c echo.Context, event notifications.Event) {
	data, err := json.Marshal(event)
	if err != nil {
		notifLogger.Error().Err(err).Msg("failed to marshal event")
		return
	}
	fmt.Fprintf(c.Response(), "data: %s\n\n", data)
}
