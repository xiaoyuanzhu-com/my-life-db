package fs

import (
	"testing"
	"time"
)

func TestMoveDetector_SameFilename(t *testing.T) {
	md := newMoveDetector(500*time.Millisecond, "")

	// Track a rename (size 0 means unknown)
	md.TrackRename("inbox/document.md", 0)

	// Check for move with same filename in different directory
	oldPath, isMove := md.CheckMove("notes/document.md")

	if !isMove {
		t.Error("expected isMove to be true")
	}

	if oldPath != "inbox/document.md" {
		t.Errorf("expected oldPath 'inbox/document.md', got '%s'", oldPath)
	}
}

func TestMoveDetector_DifferentFilename(t *testing.T) {
	md := newMoveDetector(500*time.Millisecond, "")

	// Track a rename
	md.TrackRename("inbox/document.md", 0)

	// Check for move with different filename - should NOT match
	oldPath, isMove := md.CheckMove("notes/other-file.md")

	if isMove {
		t.Errorf("expected isMove to be false for different filename, got oldPath=%s", oldPath)
	}
}

func TestMoveDetector_TTLExpiry(t *testing.T) {
	md := newMoveDetector(50*time.Millisecond, "")

	// Track a rename
	md.TrackRename("inbox/document.md", 0)

	// Wait for TTL to expire
	time.Sleep(60 * time.Millisecond)

	// Check for move - should NOT match because rename expired
	_, isMove := md.CheckMove("notes/document.md")

	if isMove {
		t.Error("expected isMove to be false after TTL expiry")
	}
}

func TestMoveDetector_MultipleRenames(t *testing.T) {
	md := newMoveDetector(500*time.Millisecond, "")

	// Track multiple renames
	md.TrackRename("inbox/file1.md", 0)
	md.TrackRename("inbox/file2.md", 0)
	md.TrackRename("inbox/file3.md", 0)

	if md.PendingCount() != 3 {
		t.Errorf("expected 3 pending renames, got %d", md.PendingCount())
	}

	// Check for moves - each should match correctly
	oldPath, isMove := md.CheckMove("notes/file2.md")
	if !isMove || oldPath != "inbox/file2.md" {
		t.Errorf("expected match for file2.md, got isMove=%v, oldPath=%s", isMove, oldPath)
	}

	if md.PendingCount() != 2 {
		t.Errorf("expected 2 pending renames after one match, got %d", md.PendingCount())
	}

	oldPath, isMove = md.CheckMove("archive/file1.md")
	if !isMove || oldPath != "inbox/file1.md" {
		t.Errorf("expected match for file1.md, got isMove=%v, oldPath=%s", isMove, oldPath)
	}

	if md.PendingCount() != 1 {
		t.Errorf("expected 1 pending rename, got %d", md.PendingCount())
	}
}

func TestMoveDetector_SameDirectoryRename(t *testing.T) {
	md := newMoveDetector(500*time.Millisecond, "")

	// Track a rename (same directory, same filename - shouldn't match)
	md.TrackRename("notes/old-name.md", 0)

	// Check with same directory but different filename - should NOT match
	_, isMove := md.CheckMove("notes/new-name.md")

	if isMove {
		t.Error("expected isMove to be false for different filename in same directory")
	}
}

func TestMoveDetector_ExactFilenameMatch(t *testing.T) {
	md := newMoveDetector(500*time.Millisecond, "")

	// Track renames with similar filenames
	md.TrackRename("inbox/test.md", 0)
	md.TrackRename("inbox/test-backup.md", 0)

	// Check for exact match - should match test.md, not test-backup.md
	oldPath, isMove := md.CheckMove("notes/test.md")

	if !isMove || oldPath != "inbox/test.md" {
		t.Errorf("expected exact match for test.md, got isMove=%v, oldPath=%s", isMove, oldPath)
	}
}

func TestMoveDetector_Clear(t *testing.T) {
	md := newMoveDetector(500*time.Millisecond, "")

	md.TrackRename("inbox/file1.md", 0)
	md.TrackRename("inbox/file2.md", 0)

	if md.PendingCount() != 2 {
		t.Errorf("expected 2 pending, got %d", md.PendingCount())
	}

	md.Clear()

	if md.PendingCount() != 0 {
		t.Errorf("expected 0 pending after clear, got %d", md.PendingCount())
	}

	// Moves should not match after clear
	_, isMove := md.CheckMove("notes/file1.md")
	if isMove {
		t.Error("expected no match after clear")
	}
}

func TestMoveDetector_NoRenameTracked(t *testing.T) {
	md := newMoveDetector(500*time.Millisecond, "")

	// Check for move without any renames tracked
	_, isMove := md.CheckMove("notes/document.md")

	if isMove {
		t.Error("expected isMove to be false when no renames tracked")
	}
}

func TestMoveDetector_DuplicateRename(t *testing.T) {
	md := newMoveDetector(500*time.Millisecond, "")

	// Track the same path twice
	md.TrackRename("inbox/file.md", 0)
	md.TrackRename("inbox/file.md", 0)

	// Should only have one entry (later one overwrites)
	if md.PendingCount() != 1 {
		t.Errorf("expected 1 pending (duplicate should overwrite), got %d", md.PendingCount())
	}

	// Should still match
	oldPath, isMove := md.CheckMove("notes/file.md")
	if !isMove || oldPath != "inbox/file.md" {
		t.Errorf("expected match, got isMove=%v, oldPath=%s", isMove, oldPath)
	}
}

func TestMoveDetector_CleanupOnCheck(t *testing.T) {
	md := newMoveDetector(50*time.Millisecond, "")

	// Track multiple renames
	md.TrackRename("inbox/old1.md", 0)
	md.TrackRename("inbox/old2.md", 0)

	// Wait for TTL to expire
	time.Sleep(60 * time.Millisecond)

	// Add a new rename that won't be expired
	md.TrackRename("inbox/new.md", 0)

	// Check for a non-matching move - this should trigger cleanup of expired entries
	md.CheckMove("notes/unrelated.md")

	// Only the new rename should remain
	if md.PendingCount() != 1 {
		t.Errorf("expected 1 pending after cleanup, got %d", md.PendingCount())
	}
}

func TestMoveDetector_MostRecentMatch(t *testing.T) {
	md := newMoveDetector(500*time.Millisecond, "")

	// Track two renames with the same filename from different directories
	md.TrackRename("inbox/document.md", 0)
	time.Sleep(10 * time.Millisecond) // Ensure different timestamps
	md.TrackRename("archive/document.md", 0)

	// Should match the most recent rename (archive/document.md)
	oldPath, isMove := md.CheckMove("notes/document.md")

	if !isMove {
		t.Error("expected isMove to be true")
	}

	if oldPath != "archive/document.md" {
		t.Errorf("expected most recent match 'archive/document.md', got '%s'", oldPath)
	}
}
