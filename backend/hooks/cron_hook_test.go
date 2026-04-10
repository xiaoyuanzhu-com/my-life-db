package hooks

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestCronHookEmitsOnSchedule(t *testing.T) {
	reg := NewRegistry()
	hook := NewCronHook(reg)

	var count atomic.Int32
	var lastPayload Payload

	reg.Subscribe(EventCronTick, func(_ context.Context, p Payload) {
		count.Add(1)
		lastPayload = p
	})

	if err := hook.AddSchedule("every-second", "* * * * * *"); err != nil {
		t.Fatalf("AddSchedule failed: %v", err)
	}

	reg.Register(hook)
	if err := reg.Start(context.Background()); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer reg.Stop()

	// Wait up to 3 seconds for at least one tick
	deadline := time.After(3 * time.Second)
	for {
		if count.Load() >= 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("expected at least 1 cron tick, got %d", count.Load())
		case <-time.After(100 * time.Millisecond):
		}
	}

	if lastPayload.EventType != EventCronTick {
		t.Errorf("expected event type %s, got %s", EventCronTick, lastPayload.EventType)
	}
	if lastPayload.Data["name"] != "every-second" {
		t.Errorf("expected name 'every-second', got %v", lastPayload.Data["name"])
	}
	if lastPayload.Data["schedule"] != "* * * * * *" {
		t.Errorf("expected schedule '* * * * * *', got %v", lastPayload.Data["schedule"])
	}
}

func TestCronHookRemoveSchedule(t *testing.T) {
	reg := NewRegistry()
	hook := NewCronHook(reg)

	var count atomic.Int32

	reg.Subscribe(EventCronTick, func(_ context.Context, _ Payload) {
		count.Add(1)
	})

	if err := hook.AddSchedule("removable", "* * * * * *"); err != nil {
		t.Fatalf("AddSchedule failed: %v", err)
	}

	reg.Register(hook)
	if err := reg.Start(context.Background()); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer reg.Stop()

	// Wait for at least one tick
	deadline := time.After(3 * time.Second)
	for {
		if count.Load() >= 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("expected at least 1 tick before removal, got %d", count.Load())
		case <-time.After(100 * time.Millisecond):
		}
	}

	// Remove the schedule and record count
	hook.RemoveSchedule("removable")
	countAfterRemoval := count.Load()

	// Wait a bit and verify no more ticks
	time.Sleep(1500 * time.Millisecond)
	finalCount := count.Load()

	if finalCount > countAfterRemoval {
		t.Errorf("expected no ticks after removal, but got %d more", finalCount-countAfterRemoval)
	}
}
