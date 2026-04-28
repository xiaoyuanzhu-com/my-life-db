package fs

import (
	"testing"
)

func TestValidatePath_SecurityOnly(t *testing.T) {
	v := newValidator()

	// Security violations should still fail
	securityTests := []struct {
		path    string
		wantErr bool
		desc    string
	}{
		{"../etc/passwd", true, "should reject directory traversal"},
		{"/etc/passwd", true, "should reject absolute path"},
		{"foo/../bar", true, "should reject embedded .."},
		{"normal/path.txt", false, "should accept normal path"},
	}

	for _, tt := range securityTests {
		t.Run(tt.desc, func(t *testing.T) {
			err := v.ValidatePath(tt.path)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidatePath(%q) error = %v, wantErr %v", tt.path, err, tt.wantErr)
			}
		})
	}

	// Excluded paths should now be ALLOWED by ValidatePath (security only)
	excludedPaths := []string{
		".DS_Store",
		".git/config",
		"media/.DS_Store",
		"node_modules/foo",
	}

	for _, path := range excludedPaths {
		t.Run("allows excluded: "+path, func(t *testing.T) {
			err := v.ValidatePath(path)
			if err != nil {
				t.Errorf("ValidatePath(%q) should allow excluded paths, got error: %v", path, err)
			}
			// But IsExcluded should still return true
			if !v.IsExcluded(path) {
				t.Errorf("IsExcluded(%q) should return true", path)
			}
		})
	}
}

func TestExclusionPatterns(t *testing.T) {
	v := newValidator()

	tests := []struct {
		path     string
		excluded bool
		desc     string
	}{
		// Specific "junk" dot-dirs are excluded
		{".git/config", true, "should exclude .git directory (VCS)"},
		{".DS_Store", true, "should exclude .DS_Store files (OS)"},
		{"node_modules/pkg/index.js", true, "should exclude node_modules (deps)"},
		{"library/.git/config", true, "should exclude .git in subdirectories"},

		// App-relevant dot-dirs are NOT excluded (visible on data page + searchable)
		{".claude/settings", false, "should NOT exclude .claude"},
		{".obsidian/workspace", false, "should NOT exclude .obsidian"},
		{"notes/.obsidian/workspace", false, "should NOT exclude .obsidian in subdirectories"},

		// Valid paths are NOT excluded
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
			result := v.IsExcluded(tt.path)
			if result != tt.excluded {
				t.Errorf("path %q: expected excluded=%v, got %v", tt.path, tt.excluded, result)
			}
		})
	}
}
