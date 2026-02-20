package notifications

import (
	"sync"
	"time"
)

// EventType represents the type of notification event
type EventType string

const (
	EventInboxChanged         EventType = "inbox-changed"
	EventLibraryChanged       EventType = "library-changed"
	EventPinChanged           EventType = "pin-changed"
	EventDigestUpdate         EventType = "digest-update"
	EventPreviewUpdated       EventType = "preview-updated"
	EventConnected            EventType = "connected"
	EventClaudeSessionUpdated EventType = "claude-session-updated"
)

// Event represents a notification event
type Event struct {
	Type      EventType `json:"type"`
	Timestamp int64     `json:"timestamp"`
	Path      string    `json:"path,omitempty"`
	Data      any       `json:"data,omitempty"`
}

// Service manages SSE subscriptions and event broadcasting
type Service struct {
	mu          sync.RWMutex
	subscribers map[chan Event]struct{}
	done        chan struct{}
}

// NewService creates a new notification service
func NewService() *Service {
	return &Service{
		subscribers: make(map[chan Event]struct{}),
		done:        make(chan struct{}),
	}
}

// Subscribe creates a new subscription channel
// Returns the event channel and an unsubscribe function
func (s *Service) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 10)

	s.mu.Lock()
	s.subscribers[ch] = struct{}{}
	s.mu.Unlock()

	unsubscribe := func() {
		s.mu.Lock()
		defer s.mu.Unlock()

		// Only close if the channel is still in subscribers map
		if _, exists := s.subscribers[ch]; exists {
			delete(s.subscribers, ch)
			close(ch)
		}
	}

	return ch, unsubscribe
}

// Notify broadcasts an event to all subscribers
func (s *Service) Notify(event Event) {
	if event.Timestamp == 0 {
		event.Timestamp = time.Now().UnixMilli()
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	for ch := range s.subscribers {
		select {
		case ch <- event:
		default:
			// Channel full, skip this subscriber
		}
	}
}

// NotifyInboxChanged sends an inbox-changed event
func (s *Service) NotifyInboxChanged() {
	s.Notify(Event{
		Type:      EventInboxChanged,
		Timestamp: time.Now().UnixMilli(),
	})
}

// NotifyLibraryChanged sends a library-changed event
// Used when files/folders are created, deleted, renamed, or moved in the library
func (s *Service) NotifyLibraryChanged(path string, operation string) {
	s.Notify(Event{
		Type:      EventLibraryChanged,
		Timestamp: time.Now().UnixMilli(),
		Path:      path,
		Data: map[string]interface{}{
			"operation": operation,
		},
	})
}

// NotifyPinChanged sends a pin-changed event
func (s *Service) NotifyPinChanged(path string) {
	s.Notify(Event{
		Type:      EventPinChanged,
		Timestamp: time.Now().UnixMilli(),
		Path:      path,
	})
}

// NotifyDigestUpdate sends a digest-update event
func (s *Service) NotifyDigestUpdate(path string, data any) {
	s.Notify(Event{
		Type:      EventDigestUpdate,
		Timestamp: time.Now().UnixMilli(),
		Path:      path,
		Data:      data,
	})
}

// NotifyPreviewUpdated sends a preview-updated event
// Used when file previews are ready (text, images, documents, screenshots)
func (s *Service) NotifyPreviewUpdated(path string, previewType string) {
	s.Notify(Event{
		Type:      EventPreviewUpdated,
		Timestamp: time.Now().UnixMilli(),
		Path:      path,
		Data: map[string]interface{}{
			"previewType": previewType,
		},
	})
}

// NotifyClaudeSessionUpdated sends a claude-session-updated event
// Used when Claude session metadata changes (title, summary, message count, status)
func (s *Service) NotifyClaudeSessionUpdated(sessionID string, operation string) {
	s.Notify(Event{
		Type:      EventClaudeSessionUpdated,
		Timestamp: time.Now().UnixMilli(),
		Data: map[string]interface{}{
			"sessionId": sessionID,
			"operation": operation,
		},
	})
}

// Shutdown closes the notification service
func (s *Service) Shutdown() {
	s.mu.Lock()
	defer s.mu.Unlock()

	close(s.done)

	// Close all subscriber channels
	for ch := range s.subscribers {
		close(ch)
	}
	s.subscribers = make(map[chan Event]struct{})
}

// SubscriberCount returns the number of active subscribers
func (s *Service) SubscriberCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.subscribers)
}
