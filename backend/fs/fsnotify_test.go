package fs

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

// TestFsnotifyBehavior documents and verifies fsnotify behavior for various scenarios.
// Run with: go test -v -run TestFsnotify ./fs/
//
// This is not a unit test - it's a documentation test to understand fsnotify behavior.

type eventLog struct {
	mu     sync.Mutex
	events []eventRecord
}

type eventRecord struct {
	time   time.Duration // relative to start
	name   string
	op     fsnotify.Op
	exists bool // whether file exists after event
}

func (e *eventLog) add(start time.Time, event fsnotify.Event) {
	e.mu.Lock()
	defer e.mu.Unlock()

	_, err := os.Stat(event.Name)
	exists := err == nil

	e.events = append(e.events, eventRecord{
		time:   time.Since(start),
		name:   filepath.Base(event.Name),
		op:     event.Op,
		exists: exists,
	})
}

func (e *eventLog) String() string {
	e.mu.Lock()
	defer e.mu.Unlock()

	var sb strings.Builder
	for _, ev := range e.events {
		existsStr := "exists"
		if !ev.exists {
			existsStr = "GONE"
		}
		sb.WriteString(fmt.Sprintf("  %6dms: %-20s op=%-20s [%s]\n",
			ev.time.Milliseconds(), ev.name, ev.op, existsStr))
	}
	return sb.String()
}

func (e *eventLog) count() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.events)
}

func (e *eventLog) getEvents() []eventRecord {
	e.mu.Lock()
	defer e.mu.Unlock()
	result := make([]eventRecord, len(e.events))
	copy(result, e.events)
	return result
}

func setupWatcher(t *testing.T, dir string) (*fsnotify.Watcher, *eventLog, func()) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("Failed to create watcher: %v", err)
	}

	if err := watcher.Add(dir); err != nil {
		t.Fatalf("Failed to watch directory: %v", err)
	}

	log := &eventLog{}
	start := time.Now()
	done := make(chan struct{})

	go func() {
		for {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				log.add(start, event)
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				t.Logf("Watcher error: %v", err)
			case <-done:
				return
			}
		}
	}()

	cleanup := func() {
		close(done)
		watcher.Close()
	}

	// Small delay to ensure watcher is ready
	time.Sleep(50 * time.Millisecond)

	return watcher, log, cleanup
}

// Test 1: Simple file create
func TestFsnotify_SimpleCreate(t *testing.T) {
	dir := t.TempDir()
	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Create file
	path := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(path, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Simple Create ===\n%s", log.String())
	t.Logf("Event count: %d", log.count())

	// Document expected behavior
	events := log.getEvents()
	if len(events) == 0 {
		t.Error("Expected at least one event")
	}

	// Check for CREATE
	hasCreate := false
	for _, e := range events {
		if e.op&fsnotify.Create != 0 {
			hasCreate = true
		}
	}
	if !hasCreate {
		t.Error("Expected CREATE event")
	}
}

// Test 2: Simple file modify
func TestFsnotify_SimpleModify(t *testing.T) {
	dir := t.TempDir()

	// Create file first
	path := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(path, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Modify file
	if err := os.WriteFile(path, []byte("world"), 0644); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Simple Modify ===\n%s", log.String())
	t.Logf("Event count: %d", log.count())

	events := log.getEvents()
	if len(events) == 0 {
		t.Error("Expected at least one event")
	}

	// Check for WRITE
	hasWrite := false
	for _, e := range events {
		if e.op&fsnotify.Write != 0 {
			hasWrite = true
		}
	}
	if !hasWrite {
		t.Error("Expected WRITE event")
	}
}

// Test 3: Simple file delete
func TestFsnotify_SimpleDelete(t *testing.T) {
	dir := t.TempDir()

	// Create file first
	path := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(path, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Delete file
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Simple Delete ===\n%s", log.String())
	t.Logf("Event count: %d", log.count())

	events := log.getEvents()
	if len(events) == 0 {
		t.Error("Expected at least one event")
	}

	// Check for REMOVE
	hasRemove := false
	for _, e := range events {
		if e.op&fsnotify.Remove != 0 {
			hasRemove = true
		}
	}
	if !hasRemove {
		t.Error("Expected REMOVE event")
	}
}

// Test 4: File rename (same directory)
func TestFsnotify_RenameSameDir(t *testing.T) {
	dir := t.TempDir()

	// Create file first
	oldPath := filepath.Join(dir, "old.txt")
	if err := os.WriteFile(oldPath, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Rename file
	newPath := filepath.Join(dir, "new.txt")
	if err := os.Rename(oldPath, newPath); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Rename Same Directory ===\n%s", log.String())
	t.Logf("Event count: %d", log.count())

	// Document what events we get
	events := log.getEvents()
	var ops []string
	for _, e := range events {
		ops = append(ops, fmt.Sprintf("%s:%s", e.name, e.op))
	}
	t.Logf("Events: %v", ops)
}

// Test 5: File move (different directory)
func TestFsnotify_MoveDifferentDir(t *testing.T) {
	dir := t.TempDir()
	subdir := filepath.Join(dir, "subdir")
	if err := os.MkdirAll(subdir, 0755); err != nil {
		t.Fatal(err)
	}

	// Create file
	oldPath := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(oldPath, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	watcher, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Also watch subdir
	if err := watcher.Add(subdir); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)

	// Move file to subdir
	newPath := filepath.Join(subdir, "test.txt")
	if err := os.Rename(oldPath, newPath); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Move Different Directory ===\n%s", log.String())
	t.Logf("Event count: %d", log.count())

	events := log.getEvents()
	var ops []string
	for _, e := range events {
		ops = append(ops, fmt.Sprintf("%s:%s", e.name, e.op))
	}
	t.Logf("Events: %v", ops)
}

// Test 6: Rapid writes
func TestFsnotify_RapidWrites(t *testing.T) {
	dir := t.TempDir()

	// Create file first
	path := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(path, []byte("v0"), 0644); err != nil {
		t.Fatal(err)
	}

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Rapid writes
	for i := 1; i <= 10; i++ {
		if err := os.WriteFile(path, []byte(fmt.Sprintf("v%d", i)), 0644); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}

	time.Sleep(200 * time.Millisecond)

	t.Logf("\n=== Rapid Writes (10 writes, 10ms apart) ===\n%s", log.String())
	t.Logf("Event count: %d (expected ~10)", log.count())
}

// Test 7: Rapid writes with no delay
func TestFsnotify_RapidWritesNoDelay(t *testing.T) {
	dir := t.TempDir()

	// Create file first
	path := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(path, []byte("v0"), 0644); err != nil {
		t.Fatal(err)
	}

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Rapid writes with no delay
	for i := 1; i <= 10; i++ {
		if err := os.WriteFile(path, []byte(fmt.Sprintf("v%d", i)), 0644); err != nil {
			t.Fatal(err)
		}
	}

	time.Sleep(200 * time.Millisecond)

	t.Logf("\n=== Rapid Writes No Delay (10 writes) ===\n%s", log.String())
	t.Logf("Event count: %d", log.count())
}

// Test 8: Create then immediate delete
func TestFsnotify_CreateThenDelete(t *testing.T) {
	dir := t.TempDir()

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	path := filepath.Join(dir, "test.txt")

	// Create
	if err := os.WriteFile(path, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	// Immediate delete (no delay)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Create Then Immediate Delete ===\n%s", log.String())
	t.Logf("Event count: %d", log.count())
}

// Test 9: Create then immediate rename
func TestFsnotify_CreateThenRename(t *testing.T) {
	dir := t.TempDir()

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	path1 := filepath.Join(dir, "test1.txt")
	path2 := filepath.Join(dir, "test2.txt")

	// Create
	if err := os.WriteFile(path1, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	// Immediate rename (no delay)
	if err := os.Rename(path1, path2); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Create Then Immediate Rename ===\n%s", log.String())
	t.Logf("Event count: %d", log.count())

	events := log.getEvents()
	var ops []string
	for _, e := range events {
		ops = append(ops, fmt.Sprintf("%s:%s", e.name, e.op))
	}
	t.Logf("Events: %v", ops)
}

// Test 10: Write then immediate rename
func TestFsnotify_WriteThenRename(t *testing.T) {
	dir := t.TempDir()

	path1 := filepath.Join(dir, "test1.txt")
	path2 := filepath.Join(dir, "test2.txt")

	// Create file first
	if err := os.WriteFile(path1, []byte("v0"), 0644); err != nil {
		t.Fatal(err)
	}

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Write
	if err := os.WriteFile(path1, []byte("v1"), 0644); err != nil {
		t.Fatal(err)
	}

	// Immediate rename
	if err := os.Rename(path1, path2); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Write Then Immediate Rename ===\n%s", log.String())

	events := log.getEvents()
	var ops []string
	for _, e := range events {
		ops = append(ops, fmt.Sprintf("%s:%s", e.name, e.op))
	}
	t.Logf("Events: %v", ops)
}

// Test 11: Multiple rapid renames
func TestFsnotify_MultipleRenames(t *testing.T) {
	dir := t.TempDir()

	path1 := filepath.Join(dir, "a.txt")
	path2 := filepath.Join(dir, "b.txt")
	path3 := filepath.Join(dir, "c.txt")

	// Create file
	if err := os.WriteFile(path1, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Chain of renames
	os.Rename(path1, path2)
	os.Rename(path2, path3)
	os.Rename(path3, path1) // back to original

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Multiple Renames (a→b→c→a) ===\n%s", log.String())

	events := log.getEvents()
	var ops []string
	for _, e := range events {
		ops = append(ops, fmt.Sprintf("%s:%s", e.name, e.op))
	}
	t.Logf("Events: %v", ops)
}

// Test 12: Atomic write pattern (write to temp, rename)
func TestFsnotify_AtomicWrite(t *testing.T) {
	dir := t.TempDir()

	targetPath := filepath.Join(dir, "target.txt")
	tempPath := filepath.Join(dir, ".target.txt.tmp")

	// Create original file
	if err := os.WriteFile(targetPath, []byte("v0"), 0644); err != nil {
		t.Fatal(err)
	}

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Atomic write pattern: write to temp, rename to target
	if err := os.WriteFile(tempPath, []byte("v1"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Atomic Write Pattern (temp → target) ===\n%s", log.String())

	events := log.getEvents()
	var ops []string
	for _, e := range events {
		ops = append(ops, fmt.Sprintf("%s:%s", e.name, e.op))
	}
	t.Logf("Events: %v", ops)
}

// Test 13: Vim-style save (backup, rename, create new)
func TestFsnotify_VimStyleSave(t *testing.T) {
	dir := t.TempDir()

	targetPath := filepath.Join(dir, "file.txt")
	backupPath := filepath.Join(dir, "file.txt~")

	// Create original file
	if err := os.WriteFile(targetPath, []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Vim-style save:
	// 1. Rename original to backup
	os.Rename(targetPath, backupPath)
	// 2. Write new content to original name
	os.WriteFile(targetPath, []byte("modified"), 0644)
	// 3. Delete backup
	os.Remove(backupPath)

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Vim-Style Save ===\n%s", log.String())

	events := log.getEvents()
	var ops []string
	for _, e := range events {
		ops = append(ops, fmt.Sprintf("%s:%s", e.name, e.op))
	}
	t.Logf("Events: %v", ops)
}

// Test 14: Event ordering - are events in order?
func TestFsnotify_EventOrdering(t *testing.T) {
	dir := t.TempDir()

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Create multiple files in order
	for i := 1; i <= 5; i++ {
		path := filepath.Join(dir, fmt.Sprintf("file%d.txt", i))
		os.WriteFile(path, []byte(fmt.Sprintf("content%d", i)), 0644)
		time.Sleep(20 * time.Millisecond)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Event Ordering (5 files created in sequence) ===\n%s", log.String())

	// Check if events are in order
	events := log.getEvents()
	var createOrder []string
	for _, e := range events {
		if e.op&fsnotify.Create != 0 {
			createOrder = append(createOrder, e.name)
		}
	}
	t.Logf("Create order: %v", createOrder)

	// Check if sorted
	sorted := make([]string, len(createOrder))
	copy(sorted, createOrder)
	sort.Strings(sorted)
	t.Logf("Sorted order: %v", sorted)
}

// Test 15: Directory create
func TestFsnotify_DirectoryCreate(t *testing.T) {
	dir := t.TempDir()

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Create subdirectory
	subdir := filepath.Join(dir, "subdir")
	if err := os.Mkdir(subdir, 0755); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Directory Create ===\n%s", log.String())
}

// Test 16: File created in unwatched subdirectory
func TestFsnotify_FileInSubdirectory(t *testing.T) {
	dir := t.TempDir()

	// Create subdir first
	subdir := filepath.Join(dir, "subdir")
	if err := os.Mkdir(subdir, 0755); err != nil {
		t.Fatal(err)
	}

	watcher, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	t.Logf("Watching: %s (NOT watching subdir)", dir)

	// Create file in subdir (not watched)
	subfile := filepath.Join(subdir, "test.txt")
	if err := os.WriteFile(subfile, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== File In Unwatched Subdirectory ===\n%s", log.String())
	t.Logf("Event count: %d (expected 0 - subdir not watched)", log.count())

	// Now add subdir to watch
	watcher.Add(subdir)
	time.Sleep(50 * time.Millisecond)

	// Modify file
	os.WriteFile(subfile, []byte("world"), 0644)
	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== After Adding Subdir to Watch ===\n%s", log.String())
}

// Test 17: chmod event
func TestFsnotify_Chmod(t *testing.T) {
	dir := t.TempDir()

	path := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(path, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Change permissions
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Chmod ===\n%s", log.String())

	events := log.getEvents()
	hasChmod := false
	for _, e := range events {
		if e.op&fsnotify.Chmod != 0 {
			hasChmod = true
		}
	}
	t.Logf("Has CHMOD event: %v", hasChmod)
}

// Test 18: Truncate vs Write
func TestFsnotify_Truncate(t *testing.T) {
	dir := t.TempDir()

	path := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(path, []byte("hello world"), 0644); err != nil {
		t.Fatal(err)
	}

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	// Truncate file
	if err := os.Truncate(path, 5); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)

	t.Logf("\n=== Truncate ===\n%s", log.String())
}

// Test 19: Large file write
func TestFsnotify_LargeFileWrite(t *testing.T) {
	dir := t.TempDir()

	_, log, cleanup := setupWatcher(t, dir)
	defer cleanup()

	path := filepath.Join(dir, "large.bin")

	// Write 10MB file
	data := make([]byte, 10*1024*1024)
	for i := range data {
		data[i] = byte(i % 256)
	}

	start := time.Now()
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	writeTime := time.Since(start)

	time.Sleep(200 * time.Millisecond)

	t.Logf("\n=== Large File Write (10MB, took %v) ===\n%s", writeTime, log.String())
	t.Logf("Event count: %d", log.count())
}

// Test 20: Summary - run all and print summary
func TestFsnotify_Summary(t *testing.T) {
	t.Log(`
===========================================
FSNOTIFY BEHAVIOR SUMMARY
===========================================

Run individual tests for details:
  go test -v -run TestFsnotify ./fs/

Key behaviors to note:
1. RENAME: old path gets RENAME event, new path gets CREATE
2. Rapid writes: Usually one event per write, but may coalesce
3. Atomic write (temp→rename): CREATE for temp, then RENAME
4. Events are generally in order
5. Subdirectories need explicit watching

See individual test output for exact event sequences.
`)
}
