package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureUserDataDirs_CreatesDirsAndReadmes(t *testing.T) {
	dir := t.TempDir()
	ensureUserDataDirs(dir)

	for _, name := range userDataDirs {
		sub := filepath.Join(dir, name)
		if info, err := os.Stat(sub); err != nil {
			t.Fatalf("%s: dir not created: %v", name, err)
		} else if !info.IsDir() {
			t.Fatalf("%s: not a directory", name)
		}

		readme := filepath.Join(sub, "README.md")
		body, err := os.ReadFile(readme)
		if err != nil {
			t.Fatalf("%s: README not written: %v", name, err)
		}
		if len(body) == 0 {
			t.Fatalf("%s: README is empty", name)
		}
	}
}

func TestEnsureUserDataDirs_PreservesUserEdits(t *testing.T) {
	dir := t.TempDir()
	ensureUserDataDirs(dir)

	// User edits one README — second run must not clobber it.
	custom := []byte("MY OWN NOTES")
	if err := os.WriteFile(filepath.Join(dir, "agents", "README.md"), custom, 0o644); err != nil {
		t.Fatal(err)
	}

	ensureUserDataDirs(dir)

	body, err := os.ReadFile(filepath.Join(dir, "agents", "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != string(custom) {
		t.Fatalf("user edit was clobbered; got %q", string(body))
	}
}

func TestEnsureUserDataDirs_RestoresDeletedReadme(t *testing.T) {
	dir := t.TempDir()
	ensureUserDataDirs(dir)

	// User deletes a README — next run should restore the default.
	if err := os.Remove(filepath.Join(dir, "explore", "README.md")); err != nil {
		t.Fatal(err)
	}

	ensureUserDataDirs(dir)

	body, err := os.ReadFile(filepath.Join(dir, "explore", "README.md"))
	if err != nil {
		t.Fatalf("README not restored: %v", err)
	}
	if !strings.Contains(string(body), "Explore") {
		t.Fatalf("restored README looks wrong: %q", string(body))
	}
}

func TestEnsureUserDataDirs_IdempotentWhenDirsExist(t *testing.T) {
	dir := t.TempDir()
	for _, name := range userDataDirs {
		if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	ensureUserDataDirs(dir)
	ensureUserDataDirs(dir)
}
