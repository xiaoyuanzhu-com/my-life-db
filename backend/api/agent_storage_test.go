package api

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestMintStorageID(t *testing.T) {
	a := mintStorageID()
	b := mintStorageID()
	if a == "" || b == "" {
		t.Fatal("mintStorageID returned empty")
	}
	if a == b {
		t.Fatal("mintStorageID returned duplicate")
	}
	if len(a) < 32 {
		t.Fatalf("mintStorageID looks too short: %q", a)
	}
}

func TestSessionDir(t *testing.T) {
	dir := sessionDir("/data", "abc-123")
	if dir != filepath.Join("/data", "sessions", "abc-123") {
		t.Fatalf("got %q", dir)
	}
}

func TestSessionUploadsDir(t *testing.T) {
	got := sessionUploadsDir("/data", "abc-123")
	want := filepath.Join("/data", "sessions", "abc-123", "uploads")
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestSessionGeneratedDir(t *testing.T) {
	got := sessionGeneratedDir("/data", "abc-123")
	want := filepath.Join("/data", "sessions", "abc-123", "generated")
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestValidStorageID(t *testing.T) {
	if !validStorageID("abc-123_def") {
		t.Error("expected alphanumeric+dash+underscore to be valid")
	}
	if validStorageID("") {
		t.Error("empty must be invalid")
	}
	if validStorageID("..") {
		t.Error("dot-dot must be invalid")
	}
	if validStorageID("a/b") {
		t.Error("slash must be invalid")
	}
	if validStorageID(strings.Repeat("a", 200)) {
		t.Error("excessively long must be invalid")
	}
}
