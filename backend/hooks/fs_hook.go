package hooks

import (
	"context"
	"time"
)

// FSHook bridges file system events from fs.Service into the hooks registry.
// It does not run its own fsnotify watcher; instead, the server calls
// EmitFileEvent when fs.Service detects changes.
type FSHook struct {
	registry *Registry
}

// NewFSHook creates a new FSHook that emits events through the given registry.
func NewFSHook(registry *Registry) *FSHook {
	return &FSHook{registry: registry}
}

// Type returns EventFileCreated as the primary event type for this hook.
func (h *FSHook) Type() EventType {
	return EventFileCreated
}

// Start is a no-op because events come from external EmitFileEvent calls.
func (h *FSHook) Start(ctx context.Context) error {
	return nil
}

// Stop is a no-op.
func (h *FSHook) Stop() error {
	return nil
}

// EmitFileEvent emits a file event with the given type and data through the registry.
func (h *FSHook) EmitFileEvent(eventType EventType, data map[string]any) {
	h.registry.Emit(Payload{
		EventType: eventType,
		Timestamp: time.Now(),
		Data:      data,
	})
}
