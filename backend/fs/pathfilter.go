package fs

import (
	"path/filepath"
	"strings"
)

// indexSkipNames is the set of directory names whose subtrees are skipped
// during scanning, indexing, and watching for performance reasons.
//
// These are universal markers — directory names that virtually always
// represent tooling output that nobody benefits from indexing:
//   - node_modules: Node.js / npm / yarn / pnpm dependency directory
//   - .git:         Git repository metadata (objects, packfiles, refs)
//   - .pnpm-store:  pnpm content-addressable package cache
//   - __pycache__:  Python compiled bytecode cache
//
// Skipping is for INDEXING ONLY. The data page tree shows everything —
// these directories remain visible to the user as a regular file browser.
//
// Adding entries here should require a high bar: a name must be (a) almost
// universally junk and (b) impractical-to-large to index. Do NOT add names
// that might be legitimate user content in some contexts.
var indexSkipNames = map[string]bool{
	"node_modules": true,
	".git":         true,
	".pnpm-store":  true,
	"__pycache__":  true,
}

// IsIndexSkipped returns true if any component of the path matches a skip
// marker. Used by the scanner, watcher, and validator to decide whether a
// path should be indexed.
func IsIndexSkipped(path string) bool {
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		if part == "" {
			continue
		}
		if indexSkipNames[part] {
			return true
		}
	}
	return false
}

// IsIndexSkippedName returns true if a single directory entry name is a
// skip marker. Use during directory iteration to avoid recursing into a
// skipped subtree.
func IsIndexSkippedName(name string) bool {
	return indexSkipNames[name]
}
