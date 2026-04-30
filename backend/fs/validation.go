package fs

import (
	"path/filepath"
	"strings"
)

// validator handles path validation (security only).
//
// Indexing-skip decisions are NOT validation — they are a separate concern
// handled by IsIndexSkipped/IsIndexSkippedName in pathfilter.go. The
// scanner/watcher consult those directly.
type validator struct{}

// newValidator creates a new validator.
func newValidator() *validator {
	return &validator{}
}

// IsExcluded reports whether the path should be skipped during indexing.
// This is a thin wrapper around IsIndexSkipped kept for the scanner/watcher
// callsites; new code should call IsIndexSkipped directly.
func (v *validator) IsExcluded(path string) bool {
	return IsIndexSkipped(path)
}

// ValidatePath checks if a path is valid and not malicious (security only).
// It does NOT consider indexing-skip rules — paths under skipped subtrees
// (e.g. node_modules) are still valid for direct file operations.
func (v *validator) ValidatePath(path string) error {
	// No absolute paths
	if filepath.IsAbs(path) {
		return ErrInvalidPath
	}

	// No .. components (directory traversal attack prevention)
	if strings.Contains(path, "..") {
		return ErrInvalidPath
	}

	// No leading /
	if strings.HasPrefix(path, "/") {
		return ErrInvalidPath
	}

	return nil
}
