package meili

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// MaxContentBytes is the maximum bytes of text content to index per file (1MB)
const MaxContentBytes = 1 * 1024 * 1024

// textExtensions is the set of file extensions recognized as text
var textExtensions = map[string]bool{
	".txt": true, ".md": true, ".markdown": true, ".tex": true, ".typ": true,
	".json": true, ".jsonl": true, ".yaml": true, ".yml": true,
	".log": true, ".csv": true, ".tsv": true,
	".xml": true, ".html": true, ".htm": true,
	".js": true, ".ts": true, ".jsx": true, ".tsx": true,
	".py": true, ".go": true, ".java": true, ".c": true, ".cpp": true, ".h": true,
	".sh": true, ".bash": true, ".zsh": true,
	".sql": true, ".conf": true, ".config": true,
	".ini": true, ".toml": true,
	".css": true, ".scss": true, ".less": true,
	".rs": true, ".rb": true, ".swift": true,
	".r": true, ".m": true, ".kt": true, ".scala": true,
	".lua": true, ".pl": true, ".pm": true,
	".vue": true, ".svelte": true,
	".dockerfile": true, ".makefile": true,
	".gitignore": true, ".env": true,
	".d.ts": true,
}

var textMimePrefixes = []string{"text/"}

var textMimeTypes = map[string]bool{
	"application/json":       true,
	"application/xml":        true,
	"application/javascript": true,
	"application/typescript": true,
	"application/x-yaml":     true,
	"application/toml":       true,
	"application/x-sh":       true,
}

// IsTextFile checks if a file is a text file based on its path extension
func IsTextFile(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return textExtensions[ext]
}

// IsTextFileByMimeType checks if a file is text based on its MIME type
func IsTextFileByMimeType(mime string) bool {
	if mime == "" {
		return false
	}
	for _, prefix := range textMimePrefixes {
		if strings.HasPrefix(mime, prefix) {
			return true
		}
	}
	return textMimeTypes[mime]
}

// ReadTextContent reads text content from a file, capped at MaxContentBytes.
// Returns empty string (not error) if file doesn't exist or can't be read.
// Truncates on a valid UTF-8 boundary.
func ReadTextContent(fullPath string) (string, error) {
	f, err := os.Open(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", nil
	}
	defer f.Close()

	buf := make([]byte, MaxContentBytes+utf8.UTFMax)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return "", nil
	}

	data := buf[:n]

	if len(data) > MaxContentBytes {
		data = data[:MaxContentBytes]
		for len(data) > 0 && !utf8.Valid(data) {
			data = data[:len(data)-1]
		}
	}

	return string(data), nil
}
