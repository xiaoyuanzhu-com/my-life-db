package fs

import (
	"path/filepath"
	"sync"
	"time"
)

// moveDetector tracks recent RENAME events to correlate with subsequent CREATE events.
// When a file is moved/renamed, fsnotify sends:
//   1. RENAME event with the OLD path (file no longer exists there)
//   2. CREATE event with the NEW path (file now exists here)
//
// By tracking recent RENAMEs, we can detect when a CREATE is actually part of a move
// operation and handle it atomically (preserving related records like digests and pins).
type moveDetector struct {
	recentRenames map[string]renameInfo
	mu            sync.Mutex
	ttl           time.Duration
}

// renameInfo stores information about a recent RENAME event
type renameInfo struct {
	timestamp time.Time
	baseName  string
}

// newMoveDetector creates a move detector with specified TTL
// TTL is how long we remember a RENAME before considering it expired
func newMoveDetector(ttl time.Duration) *moveDetector {
	return &moveDetector{
		recentRenames: make(map[string]renameInfo),
		ttl:           ttl,
	}
}

// TrackRename records a RENAME event for potential move correlation
func (m *moveDetector) TrackRename(oldPath string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Cleanup expired entries first
	now := time.Now()
	for path, info := range m.recentRenames {
		if now.Sub(info.timestamp) > m.ttl {
			delete(m.recentRenames, path)
		}
	}

	m.recentRenames[oldPath] = renameInfo{
		timestamp: now,
		baseName:  filepath.Base(oldPath),
	}
}

// CheckMove checks if a CREATE event corresponds to a recent RENAME (i.e., a move)
// Returns the old path if this is a move, empty string otherwise.
// The matching is based on filename - if a file with the same name was recently
// renamed/removed, we assume this CREATE is the destination of that move.
func (m *moveDetector) CheckMove(newPath string) (oldPath string, isMove bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	newBaseName := filepath.Base(newPath)
	now := time.Now()

	for old, info := range m.recentRenames {
		// Check for expiry
		if now.Sub(info.timestamp) > m.ttl {
			delete(m.recentRenames, old)
			continue
		}

		// Same filename = likely a move
		if info.baseName == newBaseName {
			delete(m.recentRenames, old)
			return old, true
		}
	}

	return "", false
}

// Clear removes all tracked renames (for testing or shutdown)
func (m *moveDetector) Clear() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.recentRenames = make(map[string]renameInfo)
}

// PendingCount returns the number of tracked renames (for testing)
func (m *moveDetector) PendingCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.recentRenames)
}
