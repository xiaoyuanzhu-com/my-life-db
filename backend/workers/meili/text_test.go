package meili

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsTextFile(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"notes/readme.md", true},
		{"notes/readme.txt", true},
		{"code/main.go", true},
		{"code/app.tsx", true},
		{"config/settings.json", true},
		{"config/config.yaml", true},
		{"config/config.yml", true},
		{"web/index.html", true},
		{"web/style.css", true},
		{"scripts/run.sh", true},
		{"data/data.csv", true},
		{"data/query.sql", true},
		{"config/app.toml", true},
		{"config/app.ini", true},
		{"config/app.conf", true},
		{"config/app.xml", true},
		{"code/lib.rs", true},
		{"code/main.rb", true},
		{"code/Main.java", true},
		{"code/main.c", true},
		{"code/main.cpp", true},
		{"code/main.h", true},
		{"code/main.swift", true},
		{"code/main.py", true},
		{"code/main.js", true},
		{"code/main.jsx", true},
		{"code/main.ts", true},
		{"code/types.d.ts", true},
		{"photos/image.jpg", false},
		{"photos/image.png", false},
		{"docs/document.pdf", false},
		{"music/song.mp3", false},
		{"videos/clip.mp4", false},
		{"archive/data.zip", false},
		{"data/file.bin", false},
		{"data/file.exe", false},
		{"data/file", false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := IsTextFile(tt.path); got != tt.want {
				t.Errorf("IsTextFile(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestIsTextFileByMimeType(t *testing.T) {
	tests := []struct {
		mime string
		want bool
	}{
		{"text/plain", true},
		{"text/html", true},
		{"text/markdown", true},
		{"text/css", true},
		{"text/csv", true},
		{"text/xml", true},
		{"application/json", true},
		{"application/xml", true},
		{"application/javascript", true},
		{"application/typescript", true},
		{"application/x-yaml", true},
		{"application/toml", true},
		{"image/jpeg", false},
		{"image/png", false},
		{"application/pdf", false},
		{"application/zip", false},
		{"audio/mpeg", false},
		{"video/mp4", false},
		{"application/octet-stream", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.mime, func(t *testing.T) {
			if got := IsTextFileByMimeType(tt.mime); got != tt.want {
				t.Errorf("IsTextFileByMimeType(%q) = %v, want %v", tt.mime, got, tt.want)
			}
		})
	}
}

func TestReadTextContent(t *testing.T) {
	dir := t.TempDir()

	t.Run("reads small file", func(t *testing.T) {
		path := filepath.Join(dir, "small.txt")
		os.WriteFile(path, []byte("hello world"), 0644)

		content, err := ReadTextContent(path)
		if err != nil {
			t.Fatal(err)
		}
		if content != "hello world" {
			t.Errorf("got %q, want %q", content, "hello world")
		}
	})

	t.Run("truncates at 1MB", func(t *testing.T) {
		path := filepath.Join(dir, "large.txt")
		data := strings.Repeat("a", 2*1024*1024)
		os.WriteFile(path, []byte(data), 0644)

		content, err := ReadTextContent(path)
		if err != nil {
			t.Fatal(err)
		}
		if len(content) > MaxContentBytes {
			t.Errorf("content length %d exceeds max %d", len(content), MaxContentBytes)
		}
	})

	t.Run("truncates on UTF-8 boundary", func(t *testing.T) {
		path := filepath.Join(dir, "unicode.txt")
		prefix := strings.Repeat("a", MaxContentBytes-5)
		suffix := "你好世界"
		os.WriteFile(path, []byte(prefix+suffix), 0644)

		content, err := ReadTextContent(path)
		if err != nil {
			t.Fatal(err)
		}
		if len(content) > MaxContentBytes {
			t.Errorf("content length %d exceeds max %d", len(content), MaxContentBytes)
		}
		runes := []rune(content)
		if len(runes) == 0 {
			t.Error("content should not be empty")
		}
	})

	t.Run("returns empty for missing file", func(t *testing.T) {
		content, err := ReadTextContent(filepath.Join(dir, "nonexistent.txt"))
		if err != nil {
			t.Fatal(err)
		}
		if content != "" {
			t.Errorf("expected empty, got %q", content)
		}
	})
}
