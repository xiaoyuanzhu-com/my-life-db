package hooks

import (
	"context"
	"time"
)

// EventType identifies the kind of event.
type EventType string

const (
	EventCronTick    EventType = "cron.tick"
	EventFileCreated EventType = "file.created"
	EventFileMoved   EventType = "file.moved"
	EventFileDeleted EventType = "file.deleted"
	EventFileChanged EventType = "file.changed"
	EventAppStarted  EventType = "app.started"
	EventAppStopping EventType = "app.stopping"
)

// Payload is the universal event envelope.
type Payload struct {
	EventType EventType      `json:"event_type"`
	Timestamp time.Time      `json:"timestamp"`
	Data      map[string]any `json:"data"`
}

// Subscriber is a callback invoked when an event fires.
type Subscriber func(ctx context.Context, payload Payload)

// Hook is a source of events.
type Hook interface {
	Type() EventType
	Start(ctx context.Context) error
	Stop() error
}
