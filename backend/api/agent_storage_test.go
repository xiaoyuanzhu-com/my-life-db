package api

import (
	"os"
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

func TestUniqueFilename_NoCollision(t *testing.T) {
	dir := t.TempDir()
	got := uniqueFilename(dir, "report.html")
	if got != "report.html" {
		t.Fatalf("got %q want report.html", got)
	}
}

func TestUniqueFilename_WithCollision(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "report.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := uniqueFilename(dir, "report.html")
	if got != "report-1.html" {
		t.Fatalf("got %q want report-1.html", got)
	}
}

func TestUniqueFilename_MultipleCollisions(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"report.html", "report-1.html", "report-2.html"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got := uniqueFilename(dir, "report.html")
	if got != "report-3.html" {
		t.Fatalf("got %q want report-3.html", got)
	}
}

func TestUniqueFilename_NoExtension(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := uniqueFilename(dir, "README")
	if got != "README-1" {
		t.Fatalf("got %q want README-1", got)
	}
}

func TestUniqueFilename_Dotfile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := uniqueFilename(dir, ".gitignore")
	if got != ".gitignore-1" {
		t.Fatalf("got %q want .gitignore-1", got)
	}
}
