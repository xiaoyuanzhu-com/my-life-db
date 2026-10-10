package fs

import (
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPreviewOnDemandCacheAndInvalidation(t *testing.T) {
	root := t.TempDir()
	cache := t.TempDir()
	s := NewService(Config{DataRoot: root, PreviewCacheDir: cache})
	p := filepath.Join(root, "photo.png")
	write := func(c color.Color) {
		t.Helper()
		f, err := os.Create(p)
		if err != nil {
			t.Fatal(err)
		}
		img := image.NewRGBA(image.Rect(0, 0, 8, 8))
		img.Set(0, 0, c)
		if err := png.Encode(f, img); err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
	write(color.White)
	if entries, _ := os.ReadDir(cache); len(entries) != 0 {
		t.Fatal("generated without demand")
	}
	data, err := s.Preview(context.Background(), "photo.png")
	if err != nil || len(data) == 0 {
		t.Fatalf("preview: %v", err)
	}
	entries, _ := os.ReadDir(cache)
	if len(entries) != 1 {
		t.Fatalf("cache entries: %d", len(entries))
	}
	cached, err := s.Preview(context.Background(), "photo.png")
	if err != nil || string(cached) != string(data) {
		t.Fatalf("cache miss: %v", err)
	}
	write(color.Black)
	future := time.Now().Add(time.Second)
	os.Chtimes(p, future, future)
	if _, err := s.Preview(context.Background(), "photo.png"); err != nil {
		t.Fatal(err)
	}
	entries, _ = os.ReadDir(cache)
	if len(entries) != 2 {
		t.Fatal("content change did not invalidate thumbnail")
	}
	for _, path := range []string{"../secret.png", "/etc/passwd", "missing.png"} {
		if _, err := s.Preview(context.Background(), path); err == nil {
			t.Fatalf("accepted %s", path)
		}
	}
	outside := filepath.Join(t.TempDir(), "secret.png")
	os.WriteFile(outside, data, 0600)
	if err := os.Symlink(outside, filepath.Join(root, "escape.png")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Preview(context.Background(), "escape.png"); err == nil {
		t.Fatal("followed escaping symlink")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.Preview(ctx, "photo.png"); err == nil {
		t.Fatal("ignored cancellation")
	}
}

func TestPreviewCacheEvictsOldestToBudget(t *testing.T) {
	dir := t.TempDir()
	for i, name := range []string{"old.jpg", "new.jpg"} {
		p := filepath.Join(dir, name)
		os.WriteFile(p, make([]byte, 100), 0600)
		at := time.Unix(int64(i+1), 0)
		os.Chtimes(p, at, at)
	}
	if err := trimPreviewCache(dir, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "old.jpg")); !os.IsNotExist(err) {
		t.Fatal("oldest not evicted")
	}
	if _, err := os.Stat(filepath.Join(dir, "new.jpg")); err != nil {
		t.Fatal("newest evicted")
	}
}

func TestPreviewRejectsOversizedInputs(t *testing.T) {
	root := t.TempDir()
	s := NewService(Config{DataRoot: root, PreviewCacheDir: t.TempDir()})
	f, err := os.Create(filepath.Join(root, "large.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(65 * 1024 * 1024); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if _, err := s.Preview(context.Background(), "large.png"); err == nil {
		t.Fatal("accepted oversized input")
	}
}
