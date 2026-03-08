package api

import "testing"

func TestIsArchiveFile(t *testing.T) {
	supported := []string{
		"photos.zip",
		"backup.tar",
		"backup.tar.gz",
		"backup.tgz",
		"backup.tar.bz2",
		"backup.tbz2",
		"backup.tar.xz",
		"backup.txz",
		"backup.tar.zst",
		"backup.7z",
		"backup.rar",
	}
	for _, name := range supported {
		if !isArchiveFile(name) {
			t.Errorf("isArchiveFile(%q) = false, want true", name)
		}
	}

	// Case insensitive
	caseVariants := []string{
		"Photos.ZIP",
		"Backup.TAR.GZ",
		"archive.Rar",
	}
	for _, name := range caseVariants {
		if !isArchiveFile(name) {
			t.Errorf("isArchiveFile(%q) = false, want true (case insensitive)", name)
		}
	}

	// Not archives
	notArchives := []string{
		"photo.jpg",
		"document.pdf",
		"notes.md",
		"data.json",
		"video.mp4",
		"",
	}
	for _, name := range notArchives {
		if isArchiveFile(name) {
			t.Errorf("isArchiveFile(%q) = true, want false", name)
		}
	}
}

func TestIsJunkArchiveEntry(t *testing.T) {
	junk := []string{
		"__MACOSX/file.txt",
		"__MACOSX/._photo.jpg",
		".DS_Store",
		"subdir/.DS_Store",
		"Thumbs.db",
		"subdir/Thumbs.db",
	}
	for _, path := range junk {
		if !isJunkArchiveEntry(path) {
			t.Errorf("isJunkArchiveEntry(%q) = false, want true", path)
		}
	}

	valid := []string{
		"readme.md",
		"src/main.go",
		"photos/vacation/IMG_001.jpg",
	}
	for _, path := range valid {
		if isJunkArchiveEntry(path) {
			t.Errorf("isJunkArchiveEntry(%q) = true, want false", path)
		}
	}
}

func TestIsSafeArchivePath(t *testing.T) {
	safe := []string{
		"readme.md",
		"src/main.go",
		"photos/vacation/IMG_001.jpg",
	}
	for _, path := range safe {
		if !isSafeArchivePath(path) {
			t.Errorf("isSafeArchivePath(%q) = false, want true", path)
		}
	}

	unsafe := []string{
		"../etc/passwd",
		"foo/../../etc/passwd",
		"/etc/passwd",
		"",
	}
	for _, path := range unsafe {
		if isSafeArchivePath(path) {
			t.Errorf("isSafeArchivePath(%q) = true, want false", path)
		}
	}
}
