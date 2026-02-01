package fs

import (
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Default TTL for move detection correlation.
// 500ms is enough for fsnotify to send RENAME+CREATE events for a move.
const DefaultMoveDetectorTTL = 500 * time.Millisecond

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
	dataRoot      string // For file size comparison
}

// renameInfo stores information about a recent RENAME event
type renameInfo struct {
	timestamp time.Time
	baseName  string
	size      int64 // File size at time of rename (0 if unknown)
}

// newMoveDetector creates a move detector with specified TTL
// TTL is how long we remember a RENAME before considering it expired
// dataRoot is used to look up file sizes for better matching accuracy
func newMoveDetector(ttl time.Duration, dataRoot string) *moveDetector {
	return &moveDetector{
		recentRenames: make(map[string]renameInfo),
		ttl:           ttl,
		dataRoot:      dataRoot,
	}
}

// TrackRename records a RENAME event for potential move correlation.
// size should be the file size before it was renamed (0 if unknown).
func (m *moveDetector) TrackRename(oldPath string, size int64) {
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
		size:      size,
	}
}

// CheckMove checks if a CREATE event corresponds to a recent RENAME (i.e., a move)
// Returns the old path if this is a move, empty string otherwise.
// The matching is based on:
//  1. Filename must match
//  2. If multiple matches, prefer the most recent rename
//  3. If file sizes are known, they must match
func (m *moveDetector) CheckMove(newPath string) (oldPath string, isMove bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	newBaseName := filepath.Base(newPath)
	now := time.Now()

	// Get size of new file for comparison
	var newSize int64
	if m.dataRoot != "" {
		if info, err := os.Stat(filepath.Join(m.dataRoot, newPath)); err == nil {
			newSize = info.Size()
		}
	}

	// Find the best match: same filename, most recent, matching size (if known)
	var bestMatch string
	var bestTime time.Time

	for old, info := range m.recentRenames {
		// Check for expiry
		if now.Sub(info.timestamp) > m.ttl {
			delete(m.recentRenames, old)
			continue
		}

		// Filename must match
		if info.baseName != newBaseName {
			continue
		}

		// If both sizes are known, they must match
		if info.size > 0 && newSize > 0 && info.size != newSize {
			continue
		}

		// Prefer the most recent matching rename
		if bestMatch == "" || info.timestamp.After(bestTime) {
			bestMatch = old
			bestTime = info.timestamp
		}
	}

	if bestMatch != "" {
		delete(m.recentRenames, bestMatch)
		return bestMatch, true
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
