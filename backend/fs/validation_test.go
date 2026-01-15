package fs

import (
	"testing"
)

func TestExclusionPatterns(t *testing.T) {
	v := newValidator()

	tests := []struct {
		path     string
		excluded bool
		desc     string
	}{
		// Directories starting with . at root
		{".my-life-db/database.sqlite", true, "should exclude .my-life-db directory"},
		{".git/config", true, "should exclude .git directory"},
		{".obsidian/workspace", true, "should exclude .obsidian directory"},
		{".claude/settings", true, "should exclude .claude directory"},
		{".DS_Store", true, "should exclude .DS_Store files"},

		// Directories starting with . in subdirectories
		{"notes/.obsidian/workspace", true, "should exclude .obsidian in subdirectories"},
		{"library/.git/config", true, "should exclude .git in subdirectories"},

		// Valid paths that should NOT be excluded
		{"inbox/document.pdf", false, "should NOT exclude inbox files"},
		{"notes/2024/january.md", false, "should NOT exclude notes"},
		{"journal/entry.txt", false, "should NOT exclude journal"},
		{"library/books/book.epub", false, "should NOT exclude library files"},

		// Edge cases - files with . in the name (but not at start)
		{"notes/my.document.txt", false, "should NOT exclude files with . in middle of name"},
		{"inbox/v1.2.3.pdf", false, "should NOT exclude version numbers"},
	}

	for _, tt := range tests {
		t.Run(tt.desc, func(t *testing.T) {
			result := v.isExcluded(tt.path)
			if result != tt.excluded {
				t.Errorf("path %q: expected excluded=%v, got %v", tt.path, tt.excluded, result)
			}
		})
	}
}
