package fs

import (
	"path/filepath"
	"strings"
)

// validator handles path validation and exclusion checks
type validator struct {
	pathFilter *PathFilter
}

// newValidator creates a new validator with default exclusion patterns
func newValidator() *validator {
	return &validator{
		pathFilter: DefaultPathFilter(),
	}
}

// IsExcluded checks if a path matches any exclusion pattern
func (v *validator) IsExcluded(path string) bool {
	return v.pathFilter.IsExcluded(path)
}

// ValidatePath checks if a path is valid and not malicious (security only)
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

// ValidatePathForRead checks if a path is valid for reading (security + exclusion)
// Use this for display/listing operations where excluded files should be hidden
func (v *validator) ValidatePathForRead(path string) error {
	if err := v.ValidatePath(path); err != nil {
		return err
	}

	// Check against exclusion patterns
	if v.pathFilter.IsExcluded(path) {
		return ErrExcludedPath
	}

	return nil
}
