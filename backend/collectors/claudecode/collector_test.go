package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestSync_CopiesNewFiles(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()

	// Create a project directory with a .jsonl file and sessions-index.json.
	projDir := filepath.Join(srcDir, "-Users-test")
	mustMkdir(t, projDir)
	mustWrite(t, filepath.Join(projDir, "abc123.jsonl"), "line1\nline2\n")
	mustWrite(t, filepath.Join(projDir, "sessions-index.json"), `{"sessions":[]}`)

	c := New(srcDir, dstDir)
	result, err := c.Sync(context.Background())
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}

	if result.Copied != 2 {
		t.Errorf("Copied = %d, want 2", result.Copied)
	}
	if result.Skipped != 0 {
		t.Errorf("Skipped = %d, want 0", result.Skipped)
	}
	if result.Errors != 0 {
		t.Errorf("Errors = %d, want 0", result.Errors)
	}

	// Verify content.
	assertFileContent(t, filepath.Join(dstDir, "-Users-test", "abc123.jsonl"), "line1\nline2\n")
	assertFileContent(t, filepath.Join(dstDir, "-Users-test", "sessions-index.json"), `{"sessions":[]}`)
}

func TestSync_SkipsIdenticalFiles(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()

	projDir := filepath.Join(srcDir, "-Users-test")
	mustMkdir(t, projDir)
	mustWrite(t, filepath.Join(projDir, "session.jsonl"), "data\n")

	c := New(srcDir, dstDir)

	// First sync copies.
	r1, err := c.Sync(context.Background())
	if err != nil {
		t.Fatalf("first Sync: %v", err)
	}
	if r1.Copied != 1 {
		t.Fatalf("first Copied = %d, want 1", r1.Copied)
	}

	// Second sync skips.
	r2, err := c.Sync(context.Background())
	if err != nil {
		t.Fatalf("second Sync: %v", err)
	}
	if r2.Copied != 0 {
		t.Errorf("second Copied = %d, want 0", r2.Copied)
	}
	if r2.Skipped != 1 {
		t.Errorf("second Skipped = %d, want 1", r2.Skipped)
	}
}

func TestSync_CopiesUpdatedFiles(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()

	projDir := filepath.Join(srcDir, "-Users-test")
	mustMkdir(t, projDir)
	srcFile := filepath.Join(projDir, "session.jsonl")
	mustWrite(t, srcFile, "line1\n")

	c := New(srcDir, dstDir)

	// First sync.
	if _, err := c.Sync(context.Background()); err != nil {
		t.Fatalf("first Sync: %v", err)
	}

	// Modify source (append content so size differs).
	mustWrite(t, srcFile, "line1\nline2\n")

	// Second sync should copy the updated file.
	r2, err := c.Sync(context.Background())
	if err != nil {
		t.Fatalf("second Sync: %v", err)
	}
	if r2.Copied != 1 {
		t.Errorf("Copied = %d, want 1", r2.Copied)
	}

	assertFileContent(t, filepath.Join(dstDir, "-Users-test", "session.jsonl"), "line1\nline2\n")
}

func TestSync_CopiesSubagentFiles(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()

	// Create nested subagent path: {project}/{session-id}/subagents/agent-xyz.jsonl
	subagentDir := filepath.Join(srcDir, "-Users-test", "abc123", "subagents")
	mustMkdir(t, subagentDir)
	mustWrite(t, filepath.Join(subagentDir, "agent-xyz.jsonl"), "subagent data\n")

	c := New(srcDir, dstDir)
	result, err := c.Sync(context.Background())
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}

	if result.Copied != 1 {
		t.Errorf("Copied = %d, want 1", result.Copied)
	}

	assertFileContent(t,
		filepath.Join(dstDir, "-Users-test", "abc123", "subagents", "agent-xyz.jsonl"),
		"subagent data\n",
	)
}

func TestSync_SkipsUnexpectedFiles(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()

	projDir := filepath.Join(srcDir, "-Users-test")
	mustMkdir(t, projDir)
	mustWrite(t, filepath.Join(projDir, "session.jsonl"), "data\n")
	mustWrite(t, filepath.Join(projDir, "notes.txt"), "ignored\n")
	mustWrite(t, filepath.Join(projDir, ".DS_Store"), "ignored\n")

	c := New(srcDir, dstDir)
	result, err := c.Sync(context.Background())
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}

	if result.Copied != 1 {
		t.Errorf("Copied = %d, want 1", result.Copied)
	}

	// Verify only .jsonl was copied.
	assertFileContent(t, filepath.Join(dstDir, "-Users-test", "session.jsonl"), "data\n")

	// Verify .txt and .DS_Store were NOT copied.
	assertFileNotExists(t, filepath.Join(dstDir, "-Users-test", "notes.txt"))
	assertFileNotExists(t, filepath.Join(dstDir, "-Users-test", ".DS_Store"))
}

func TestSync_SourceDirMissing(t *testing.T) {
	srcDir := filepath.Join(t.TempDir(), "nonexistent")
	dstDir := t.TempDir()

	c := New(srcDir, dstDir)
	result, err := c.Sync(context.Background())
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}

	if result.Copied != 0 {
		t.Errorf("Copied = %d, want 0", result.Copied)
	}
	if result.Skipped != 0 {
		t.Errorf("Skipped = %d, want 0", result.Skipped)
	}
	if result.Errors != 0 {
		t.Errorf("Errors = %d, want 0", result.Errors)
	}
}

// --- test helpers ---

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertFileContent(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(got) != want {
		t.Errorf("content of %s = %q, want %q", path, got, want)
	}
}

func assertFileNotExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err == nil {
		t.Errorf("file %s exists, want not to exist", path)
	}
}
