package hooks

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestFSHookEmitFileCreated(t *testing.T) {
	reg := NewRegistry()
	hook := NewFSHook(reg)
	reg.Register(hook)

	if err := reg.Start(context.Background()); err != nil {
		t.Fatalf("failed to start registry: %v", err)
	}
	defer reg.Stop()

	var mu sync.Mutex
	var received *Payload

	reg.Subscribe(EventFileCreated, func(ctx context.Context, p Payload) {
		mu.Lock()
		received = &p
		mu.Unlock()
	})

	data := map[string]any{
		"path":      "/inbox/photo.jpg",
		"name":      "photo.jpg",
		"folder":    "inbox",
		"size":      int64(2048),
		"mime_type": "image/jpeg",
	}
	hook.EmitFileEvent(EventFileCreated, data)

	// Wait for async subscriber
	deadline := time.After(time.Second)
	for {
		mu.Lock()
		got := received
		mu.Unlock()
		if got != nil {
			break
		}
		select {
		case <-deadline:
			t.Fatal("timed out waiting for file.created event")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}

	mu.Lock()
	defer mu.Unlock()

	if received.EventType != EventFileCreated {
		t.Errorf("expected event type %s, got %s", EventFileCreated, received.EventType)
	}
	if received.Timestamp.IsZero() {
		t.Error("expected non-zero timestamp")
	}
	if received.Data["path"] != "/inbox/photo.jpg" {
		t.Errorf("expected path /inbox/photo.jpg, got %v", received.Data["path"])
	}
	if received.Data["name"] != "photo.jpg" {
		t.Errorf("expected name photo.jpg, got %v", received.Data["name"])
	}
	if received.Data["folder"] != "inbox" {
		t.Errorf("expected folder inbox, got %v", received.Data["folder"])
	}
	if received.Data["size"] != int64(2048) {
		t.Errorf("expected size 2048, got %v", received.Data["size"])
	}
	if received.Data["mime_type"] != "image/jpeg" {
		t.Errorf("expected mime_type image/jpeg, got %v", received.Data["mime_type"])
	}
}

func TestFSHookEmitFileMoved(t *testing.T) {
	reg := NewRegistry()
	hook := NewFSHook(reg)
	reg.Register(hook)

	if err := reg.Start(context.Background()); err != nil {
		t.Fatalf("failed to start registry: %v", err)
	}
	defer reg.Stop()

	var mu sync.Mutex
	var received *Payload

	reg.Subscribe(EventFileMoved, func(ctx context.Context, p Payload) {
		mu.Lock()
		received = &p
		mu.Unlock()
	})

	data := map[string]any{
		"from_path": "/inbox/doc.pdf",
		"to_path":   "/notes/doc.pdf",
		"name":      "doc.pdf",
	}
	hook.EmitFileEvent(EventFileMoved, data)

	// Wait for async subscriber
	deadline := time.After(time.Second)
	for {
		mu.Lock()
		got := received
		mu.Unlock()
		if got != nil {
			break
		}
		select {
		case <-deadline:
			t.Fatal("timed out waiting for file.moved event")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}

	mu.Lock()
	defer mu.Unlock()

	if received.EventType != EventFileMoved {
		t.Errorf("expected event type %s, got %s", EventFileMoved, received.EventType)
	}
	if received.Timestamp.IsZero() {
		t.Error("expected non-zero timestamp")
	}
	if received.Data["from_path"] != "/inbox/doc.pdf" {
		t.Errorf("expected from_path /inbox/doc.pdf, got %v", received.Data["from_path"])
	}
	if received.Data["to_path"] != "/notes/doc.pdf" {
		t.Errorf("expected to_path /notes/doc.pdf, got %v", received.Data["to_path"])
	}
	if received.Data["name"] != "doc.pdf" {
		t.Errorf("expected name doc.pdf, got %v", received.Data["name"])
	}
}
