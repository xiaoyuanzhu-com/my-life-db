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

	// Index-skipped paths should be ALLOWED by ValidatePath (security only)
	skippedPaths := []string{
		".git/config",
		"node_modules/foo",
		"some/__pycache__/x.pyc",
		"deep/.pnpm-store/v3/abc",
	}

	for _, path := range skippedPaths {
		t.Run("allows skipped: "+path, func(t *testing.T) {
			err := v.ValidatePath(path)
			if err != nil {
				t.Errorf("ValidatePath(%q) should allow skipped paths, got error: %v", path, err)
			}
			// But IsExcluded should still return true (delegates to IsIndexSkipped)
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
		// The four universal index-skip markers
		{".git/config", true, "should skip .git directory (VCS)"},
		{"node_modules/pkg/index.js", true, "should skip node_modules (deps)"},
		{"library/.git/config", true, "should skip .git in subdirectories"},
		{"py/__pycache__/mod.pyc", true, "should skip __pycache__"},
		{"x/.pnpm-store/v3/files", true, "should skip .pnpm-store"},

		// Everything else is indexed — including OS files and app dot-dirs
		{".DS_Store", false, "should NOT skip .DS_Store (not a marker)"},
		{".claude/settings", false, "should NOT skip .claude"},
		{".obsidian/workspace", false, "should NOT skip .obsidian"},
		{"notes/.obsidian/workspace", false, "should NOT skip .obsidian in subdirectories"},

		// Valid paths are NOT skipped
		{"inbox/document.pdf", false, "should NOT skip inbox files"},
		{"notes/2024/january.md", false, "should NOT skip notes"},
		{"journal/entry.txt", false, "should NOT skip journal"},
		{"library/books/book.epub", false, "should NOT skip library files"},

		// Edge cases - files with . in the name (but not at start)
		{"notes/my.document.txt", false, "should NOT skip files with . in middle of name"},
		{"inbox/v1.2.3.pdf", false, "should NOT skip version numbers"},
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
