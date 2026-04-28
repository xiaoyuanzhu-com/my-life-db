package api

import (
	"path/filepath"

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
