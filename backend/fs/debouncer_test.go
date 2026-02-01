package fs

import (
	"sync"
	"testing"
	"time"
)

func TestDebouncer_CoalescesRapidWrites(t *testing.T) {
	var processed []struct {
		path      string
		eventType EventType
	}
	var mu sync.Mutex

	d := newDebouncer(50*time.Millisecond, func(path string, eventType EventType) {
		mu.Lock()
		processed = append(processed, struct {
			path      string
			eventType EventType
		}{path, eventType})
		mu.Unlock()
	})
	defer d.Stop()

	// Queue multiple rapid writes to the same file
	for i := 0; i < 5; i++ {
		d.Queue("test.txt", EventWrite)
		time.Sleep(10 * time.Millisecond)
	}

	// Wait for debounce to fire
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(processed) != 1 {
		t.Errorf("expected 1 processed event, got %d", len(processed))
	}

	if len(processed) > 0 && processed[0].path != "test.txt" {
		t.Errorf("expected path 'test.txt', got '%s'", processed[0].path)
	}

	if len(processed) > 0 && processed[0].eventType != EventWrite {
		t.Errorf("expected EventWrite, got %v", processed[0].eventType)
	}
}

func TestDebouncer_DeleteIsImmediate(t *testing.T) {
	var processed []EventType
	var mu sync.Mutex
	done := make(chan bool, 1)

	d := newDebouncer(100*time.Millisecond, func(path string, eventType EventType) {
		mu.Lock()
		processed = append(processed, eventType)
		mu.Unlock()
		if eventType == EventDelete {
			done <- true
		}
	})
	defer d.Stop()

	// Queue a delete - should be processed immediately
	d.Queue("test.txt", EventDelete)

	// Wait briefly for immediate processing
	select {
	case <-done:
		// Good, delete was processed quickly
	case <-time.After(50 * time.Millisecond):
		t.Error("delete was not processed immediately")
	}

	mu.Lock()
	defer mu.Unlock()

	if len(processed) != 1 || processed[0] != EventDelete {
		t.Errorf("expected immediate delete processing, got %v", processed)
	}
}

func TestDebouncer_ResetTimerOnNewEvent(t *testing.T) {
	var processedAt []time.Time
	var mu sync.Mutex

	d := newDebouncer(50*time.Millisecond, func(path string, eventType EventType) {
		mu.Lock()
		processedAt = append(processedAt, time.Now())
		mu.Unlock()
	})
	defer d.Stop()

	startTime := time.Now()

	// Queue event at T0
	d.Queue("test.txt", EventWrite)

	// Queue again at T25 - should reset timer
	time.Sleep(25 * time.Millisecond)
	d.Queue("test.txt", EventWrite)

	// Queue again at T50 - should reset timer again
	time.Sleep(25 * time.Millisecond)
	d.Queue("test.txt", EventWrite)

	// Wait for debounce to fire
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(processedAt) != 1 {
		t.Errorf("expected 1 processed event, got %d", len(processedAt))
	}

	// Should have been processed ~100ms after start (50ms + 50ms + ~50ms delay)
	// Allow some tolerance for timing
	elapsed := processedAt[0].Sub(startTime)
	if elapsed < 90*time.Millisecond {
		t.Errorf("event processed too early: %v", elapsed)
	}
}

func TestDebouncer_IndependentPaths(t *testing.T) {
	var processed []string
	var mu sync.Mutex

	d := newDebouncer(50*time.Millisecond, func(path string, eventType EventType) {
		mu.Lock()
		processed = append(processed, path)
		mu.Unlock()
	})
	defer d.Stop()

	// Queue events for different files
	d.Queue("file1.txt", EventWrite)
	d.Queue("file2.txt", EventWrite)
	d.Queue("file3.txt", EventWrite)

	// Wait for all to process
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(processed) != 3 {
		t.Errorf("expected 3 processed events, got %d", len(processed))
	}

	// Check all files were processed
	found := make(map[string]bool)
	for _, p := range processed {
		found[p] = true
	}

	for _, expected := range []string{"file1.txt", "file2.txt", "file3.txt"} {
		if !found[expected] {
			t.Errorf("expected %s to be processed", expected)
		}
	}
}

func TestDebouncer_CreateOverridesWrite(t *testing.T) {
	var lastEventType EventType
	var mu sync.Mutex

	d := newDebouncer(50*time.Millisecond, func(path string, eventType EventType) {
		mu.Lock()
		lastEventType = eventType
		mu.Unlock()
	})
	defer d.Stop()

	// Queue write first, then create
	d.Queue("test.txt", EventWrite)
	d.Queue("test.txt", EventCreate)

	// Wait for processing
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if lastEventType != EventCreate {
		t.Errorf("expected EventCreate to take precedence, got %v", lastEventType)
	}
}

func TestDebouncer_DeleteCancelsPending(t *testing.T) {
	var processed []EventType
	var mu sync.Mutex

	d := newDebouncer(100*time.Millisecond, func(path string, eventType EventType) {
		mu.Lock()
		processed = append(processed, eventType)
		mu.Unlock()
	})
	defer d.Stop()

	// Queue a write (will be pending for 100ms)
	d.Queue("test.txt", EventWrite)

	// Immediately queue a delete - should cancel the pending write
	d.Queue("test.txt", EventDelete)

	// Wait for everything to settle
	time.Sleep(150 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	// Should only have the delete, not the write
	if len(processed) != 1 || processed[0] != EventDelete {
		t.Errorf("expected only delete to be processed, got %v", processed)
	}
}

func TestDebouncer_Stop(t *testing.T) {
	callCount := 0
	var mu sync.Mutex

	d := newDebouncer(50*time.Millisecond, func(path string, eventType EventType) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})

	// Queue an event
	d.Queue("test.txt", EventWrite)

	// Stop before it fires
	d.Stop()

	// Wait past the debounce time
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if callCount != 0 {
		t.Errorf("expected no calls after Stop, got %d", callCount)
	}
}

func TestDebouncer_PendingCount(t *testing.T) {
	d := newDebouncer(100*time.Millisecond, func(path string, eventType EventType) {})
	defer d.Stop()

	if d.PendingCount() != 0 {
		t.Error("expected 0 pending initially")
	}

	d.Queue("file1.txt", EventWrite)
	d.Queue("file2.txt", EventWrite)

	if d.PendingCount() != 2 {
		t.Errorf("expected 2 pending, got %d", d.PendingCount())
	}

	// Wait for processing
	time.Sleep(150 * time.Millisecond)

	if d.PendingCount() != 0 {
		t.Errorf("expected 0 pending after processing, got %d", d.PendingCount())
	}
}

func TestDebouncer_QueueAfterStop(t *testing.T) {
	d := newDebouncer(50*time.Millisecond, func(path string, eventType EventType) {
		t.Error("should not be called after stop")
	})

	// Stop first
	d.Stop()

	// Queue should return false after stop
	if d.Queue("test.txt", EventWrite) {
		t.Error("expected Queue to return false after Stop")
	}

	if d.Queue("test.txt", EventDelete) {
		t.Error("expected Queue to return false for delete after Stop")
	}

	// Wait to ensure no processing happens
	time.Sleep(100 * time.Millisecond)
}
