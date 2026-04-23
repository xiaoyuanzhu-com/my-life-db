package server

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSweepAgentAttachments(t *testing.T) {
	tmpDir := t.TempDir()
	root := filepath.Join(tmpDir, "tmp", "agent-uploads")

	// Seed three upload dirs:
	//   old:    mtime 40 days ago  → should be deleted
	//   recent: mtime 5 days ago   → should be kept
	//   brand:  mtime now          → should be kept
	old := filepath.Join(root, "old")
	recent := filepath.Join(root, "recent")
	brand := filepath.Join(root, "brand")
	for _, d := range []string{old, recent, brand} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("seed %s: %v", d, err)
		}
		if err := os.WriteFile(filepath.Join(d, "f.txt"), []byte("x"), 0o644); err != nil {
			t.Fatalf("seed file: %v", err)
		}
	}

	now := time.Now()
	if err := os.Chtimes(old, now.Add(-40*24*time.Hour), now.Add(-40*24*time.Hour)); err != nil {
		t.Fatalf("chtimes old: %v", err)
	}
	if err := os.Chtimes(recent, now.Add(-5*24*time.Hour), now.Add(-5*24*time.Hour)); err != nil {
		t.Fatalf("chtimes recent: %v", err)
	}

	removed, err := SweepAgentAttachments(tmpDir, 30*24*time.Hour)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("old dir should be deleted")
	}
	if _, err := os.Stat(recent); err != nil {
		t.Fatalf("recent dir should be kept: %v", err)
	}
	if _, err := os.Stat(brand); err != nil {
		t.Fatalf("brand dir should be kept: %v", err)
	}
}

func TestSweepAgentAttachments_RootMissing(t *testing.T) {
	// No root dir yet — sweep should be a no-op, not an error.
	tmpDir := t.TempDir()
	removed, err := SweepAgentAttachments(tmpDir, 30*24*time.Hour)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if removed != 0 {
		t.Fatalf("removed = %d", removed)
	}
}
