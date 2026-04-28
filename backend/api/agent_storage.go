package api

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// mintStorageID returns a fresh per-session storage id (UUIDv4).
// Used as the directory name under USER_DATA_DIR/sessions/.
func mintStorageID() string {
	return uuid.New().String()
}

// sessionDir returns USER_DATA_DIR/sessions/<storageID>.
func sessionDir(userDataDir, storageID string) string {
	return filepath.Join(userDataDir, "sessions", storageID)
}

// sessionUploadsDir returns USER_DATA_DIR/sessions/<storageID>/uploads.
func sessionUploadsDir(userDataDir, storageID string) string {
	return filepath.Join(sessionDir(userDataDir, storageID), "uploads")
}

// sessionGeneratedDir returns USER_DATA_DIR/sessions/<storageID>/generated.
func sessionGeneratedDir(userDataDir, storageID string) string {
	return filepath.Join(sessionDir(userDataDir, storageID), "generated")
}

// uniqueFilename returns a filename within dir that does not yet exist on disk.
// If dir/name is free, it returns name unchanged. Otherwise it appends a
// numeric suffix before the extension: report.html -> report-1.html.
// Hidden files like .gitignore are treated as having no extension, so the
// suffix is appended to the end: .gitignore -> .gitignore-1.
// If 9999 candidates are all taken, name is returned unchanged (the caller's
// subsequent os.Create will then overwrite the existing file — acceptable for
// a per-session staging directory where this is essentially impossible).
// Caller is responsible for creating dir.
func uniqueFilename(dir, name string) string {
	full := filepath.Join(dir, name)
	if _, err := os.Stat(full); os.IsNotExist(err) {
		return name
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	if stem == "" {
		// Dotfile (e.g. .gitignore): treat the whole name as the stem.
		ext = ""
		stem = name
	}
	for i := 1; i < 10000; i++ {
		candidate := stem + "-" + strconv.Itoa(i) + ext
		if _, err := os.Stat(filepath.Join(dir, candidate)); os.IsNotExist(err) {
			return candidate
		}
	}
	return name
}

// validStorageID rejects empty values, path traversal sequences, separators,
// and excessively long ids. Used to sanitize values that came from request
// bodies / URL params before they're joined into a filesystem path.
func validStorageID(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	if s == "." || s == ".." {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}
	return true
}
