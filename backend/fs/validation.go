package fs

import (
	"path/filepath"
	"regexp"
	"strings"
)

// Default exclusion patterns for filesystem operations
var defaultExclusionPatterns = []string{
	`^\..+`,      // Any path starting with a dot + more chars (e.g., .obsidian, .git, .DS_Store) - excludes "." itself
	`/\.[^/]+`,   // Any path component starting with a dot in subdirectories (e.g., inbox/.hidden)
	`(^|/)~.*$`,  // Backup files starting with ~
}

// validator handles path validation and exclusion checks
type validator struct {
	exclusionPatterns []*regexp.Regexp
}

// newValidator creates a new validator with compiled exclusion patterns
func newValidator() *validator {
	exclusionPatterns := make([]*regexp.Regexp, 0, len(defaultExclusionPatterns))
	for _, pattern := range defaultExclusionPatterns {
		re, err := regexp.Compile(pattern)
		if err != nil {
			// Log warning but continue (skip invalid patterns)
			continue
		}
		exclusionPatterns = append(exclusionPatterns, re)
	}

	return &validator{
		exclusionPatterns: exclusionPatterns,
	}
}

// ValidatePath checks if a path is valid and not malicious
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

	// Check against exclusion patterns
	if v.isExcluded(path) {
		return ErrExcludedPath
	}

	return nil
}

// isExcluded checks if a path matches any exclusion pattern
func (v *validator) isExcluded(path string) bool {
	for _, pattern := range v.exclusionPatterns {
		if pattern.MatchString(path) {
			return true
		}
	}
	return false
}
