package notifications

import (
	"sync"
	"time"
)

// EventType represents the type of notification event
type EventType string

const (
	EventInboxChanged   EventType = "inbox-changed"
	EventPinChanged     EventType = "pin-changed"
	EventDigestUpdate   EventType = "digest-update"
	EventPreviewUpdated EventType = "preview-updated"
	EventConnected      EventType = "connected"
)

// Event represents a notification event
type Event struct {
	Type      EventType `json:"type"`
	Timestamp string    `json:"timestamp"`
	Path      string    `json:"path,omitempty"`
	Data      any       `json:"data,omitempty"`
}

// Service manages SSE subscriptions and event broadcasting
type Service struct {
	mu          sync.RWMutex
	subscribers map[chan Event]struct{}
	done        chan struct{}
}

var (
	// TEMPORARY: Global instance for backward compatibility during refactoring
	// This will be removed once Server owns the notifications.Service
	globalInstance *Service
	globalOnce     sync.Once
)

// NewService creates a new notification service
func NewService() *Service {
	s := &Service{
		subscribers: make(map[chan Event]struct{}),
		done:        make(chan struct{}),
	}

	// Set as global for backward compatibility
	globalOnce.Do(func() {
		globalInstance = s
	})

	return s
}

// GetService returns the global notification service
// DEPRECATED: This is temporary for backward compatibility
// Use notifications.Service instance passed from Server instead
func GetService() *Service {
	globalOnce.Do(func() {
		globalInstance = NewService()
	})
	return globalInstance
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
	if event.Timestamp == "" {
		event.Timestamp = time.Now().UTC().Format(time.RFC3339)
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
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	})
}

// NotifyPinChanged sends a pin-changed event
func (s *Service) NotifyPinChanged(path string) {
	s.Notify(Event{
		Type:      EventPinChanged,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Path:      path,
	})
}

// NotifyDigestUpdate sends a digest-update event
func (s *Service) NotifyDigestUpdate(path string, data any) {
	s.Notify(Event{
		Type:      EventDigestUpdate,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Path:      path,
		Data:      data,
	})
}

// NotifyPreviewUpdated sends a preview-updated event
// Used when file previews are ready (text, images, documents, screenshots)
func (s *Service) NotifyPreviewUpdated(path string, previewType string) {
	s.Notify(Event{
		Type:      EventPreviewUpdated,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Path:      path,
		Data: map[string]interface{}{
			"previewType": previewType,
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
