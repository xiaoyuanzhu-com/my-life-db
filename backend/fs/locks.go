package fs

import "sync"

// fileLock manages per-file locking to allow concurrent operations on different files
// while ensuring sequential operations on the same file
type fileLock struct {
	locks      sync.Map // map[string]*sync.Mutex
	processing sync.Map // map[string]bool (for duplicate detection)
}

// acquireFileLock returns the mutex for a specific file path
// Each file has its own mutex, allowing parallel operations on different files
func (fl *fileLock) acquireFileLock(path string) *sync.Mutex {
	muInterface, _ := fl.locks.LoadOrStore(path, &sync.Mutex{})
	return muInterface.(*sync.Mutex)
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
