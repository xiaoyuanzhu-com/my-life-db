package fs

import (
	"sync"
	"time"
)

// EventType represents the type of filesystem event
type EventType int

const (
	EventCreate EventType = iota
	EventWrite
	EventDelete
)

// String returns the string representation of an EventType
func (e EventType) String() string {
	switch e {
	case EventCreate:
		return "create"
	case EventWrite:
		return "write"
	case EventDelete:
		return "delete"
	default:
		return "unknown"
	}
}

// debouncer coalesces rapid filesystem events to avoid duplicate processing.
// Events for the same path are queued and only processed after a delay period
// of no new events. DELETE events are processed immediately.
type debouncer struct {
	pending   map[string]*pendingEvent
	mu        sync.Mutex
	delay     time.Duration
	onProcess func(path string, eventType EventType)
}

// pendingEvent represents a queued event waiting to be processed
type pendingEvent struct {
	path      string
	timer     *time.Timer
	eventType EventType
}

// newDebouncer creates a debouncer with specified delay
func newDebouncer(delay time.Duration, onProcess func(path string, eventType EventType)) *debouncer {
	return &debouncer{
		pending:   make(map[string]*pendingEvent),
		delay:     delay,
		onProcess: onProcess,
	}
}

// Queue adds an event to the debounce queue.
// DELETE events are processed immediately.
// CREATE/WRITE events wait for the debounce delay.
// New events for the same path reset the timer.
func (d *debouncer) Queue(path string, eventType EventType) {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Delete is immediate - cancel any pending event and process now
	if eventType == EventDelete {
		if p, ok := d.pending[path]; ok {
			p.timer.Stop()
			delete(d.pending, path)
		}
		// Process delete immediately (in a goroutine to avoid blocking)
		go d.onProcess(path, EventDelete)
		return
	}

	// Check if already pending
	if p, ok := d.pending[path]; ok {
		// Reset timer
		p.timer.Reset(d.delay)
		// Upgrade event type if needed: CREATE takes precedence over WRITE
		// (if we see CREATE then WRITE, treat as CREATE)
		if eventType == EventCreate {
			p.eventType = EventCreate
		}
		return
	}

	// New pending event
	timer := time.AfterFunc(d.delay, func() {
		d.onTimer(path)
	})
	d.pending[path] = &pendingEvent{
		path:      path,
		timer:     timer,
		eventType: eventType,
	}
}

// onTimer fires when debounce delay expires
func (d *debouncer) onTimer(path string) {
	d.mu.Lock()
	p, ok := d.pending[path]
	if ok {
		delete(d.pending, path)
	}
	d.mu.Unlock()

	if ok {
		d.onProcess(path, p.eventType)
	}
}

// Stop cancels all pending events
func (d *debouncer) Stop() {
	d.mu.Lock()
	defer d.mu.Unlock()

	for _, p := range d.pending {
		p.timer.Stop()
	}
	d.pending = make(map[string]*pendingEvent)
}

// PendingCount returns the number of pending events (for testing)
func (d *debouncer) PendingCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.pending)
}
