package fs

import (
	"sync"
	"time"
)

// Maximum age for unused lock entries before cleanup
const lockCleanupMaxAge = 1 * time.Hour

// fileLock manages per-file locking to allow concurrent operations on different files
// while ensuring sequential operations on the same file
type fileLock struct {
	locks      sync.Map // map[string]*lockEntry
	processing sync.Map // map[string]bool (for duplicate detection)
}

// lockEntry wraps a mutex with a last-accessed timestamp for cleanup
type lockEntry struct {
	mu         sync.Mutex
	lastAccess time.Time
}

// acquireFileLock returns the mutex for a specific file path
// Each file has its own mutex, allowing parallel operations on different files
func (fl *fileLock) acquireFileLock(path string) *sync.Mutex {
	now := time.Now()
	entry, loaded := fl.locks.LoadOrStore(path, &lockEntry{lastAccess: now})
	le := entry.(*lockEntry)

	// Update last access time if entry already existed
	if loaded {
		le.lastAccess = now
	}

	return &le.mu
}

// releaseFileLock removes the lock for a file (garbage collection)
// Called after file is deleted to prevent memory leaks
func (fl *fileLock) releaseFileLock(path string) {
	fl.locks.Delete(path)
	fl.processing.Delete(path)
}

// isProcessing checks if file is currently being processed
func (fl *fileLock) isProcessing(path string) bool {
	_, exists := fl.processing.Load(path)
	return exists
}

// markProcessing marks a file as being processed
// Returns true if mark was successful (file wasn't already marked)
func (fl *fileLock) markProcessing(path string) bool {
	_, loaded := fl.processing.LoadOrStore(path, true)
	return !loaded // true if we got the mark
}

// unmarkProcessing removes processing mark
func (fl *fileLock) unmarkProcessing(path string) {
	fl.processing.Delete(path)
}

// cleanupStale removes lock entries that haven't been accessed recently.
// This prevents unbounded memory growth from file churn over time.
// Should be called periodically (e.g., after each scan).
func (fl *fileLock) cleanupStale() int {
	now := time.Now()
	cleaned := 0

	fl.locks.Range(func(key, value interface{}) bool {
		le := value.(*lockEntry)

		// Skip if recently accessed
		if now.Sub(le.lastAccess) < lockCleanupMaxAge {
			return true
		}

		// Try to acquire lock to ensure it's not in use
		// Use TryLock to avoid blocking
		if le.mu.TryLock() {
			// Successfully locked - safe to delete
			fl.locks.Delete(key)
			le.mu.Unlock()
			cleaned++
		}
		// If TryLock failed, the lock is in use - skip it

		return true
	})

	return cleaned
}

// cleanup removes all lock entries (called during shutdown)
func (fl *fileLock) cleanup() {
	fl.locks.Range(func(key, _ interface{}) bool {
		fl.locks.Delete(key)
		return true
	})
	fl.processing.Range(func(key, _ interface{}) bool {
		fl.processing.Delete(key)
		return true
	})
}
