package hooks

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestEmitFansOutToMatchingSubscribers(t *testing.T) {
	r := NewRegistry()

	var mu sync.Mutex
	var received []Payload

	r.Subscribe(EventFileCreated, func(ctx context.Context, p Payload) {
		mu.Lock()
		received = append(received, p)
		mu.Unlock()
	})

	payload := Payload{
		EventType: EventFileCreated,
		Timestamp: time.Now(),
		Data:      map[string]any{"path": "/inbox/test.txt"},
	}
	r.Emit(payload)

	// Give goroutine time to execute.
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 1 {
		t.Fatalf("expected 1 callback, got %d", len(received))
	}
	if received[0].EventType != EventFileCreated {
		t.Fatalf("expected event type %q, got %q", EventFileCreated, received[0].EventType)
	}
}

func TestEmitDoesNotCallUnrelatedSubscribers(t *testing.T) {
	r := NewRegistry()

	called := false
	r.Subscribe(EventFileDeleted, func(ctx context.Context, p Payload) {
		called = true
	})

	r.Emit(Payload{
		EventType: EventFileCreated,
		Timestamp: time.Now(),
		Data:      map[string]any{},
	})

	time.Sleep(50 * time.Millisecond)

	if called {
		t.Fatal("subscriber for file.deleted should not be called on file.created event")
	}
}

func TestMultipleSubscribersSameEvent(t *testing.T) {
	r := NewRegistry()

	var mu sync.Mutex
	count := 0

	for i := 0; i < 3; i++ {
		r.Subscribe(EventCronTick, func(ctx context.Context, p Payload) {
			mu.Lock()
			count++
			mu.Unlock()
		})
	}

	r.Emit(Payload{
		EventType: EventCronTick,
		Timestamp: time.Now(),
		Data:      map[string]any{"schedule": "*/5 * * * *"},
	})

	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if count != 3 {
		t.Fatalf("expected 3 subscribers called, got %d", count)
	}
}
