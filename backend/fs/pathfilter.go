package fs

import (
	"path/filepath"
	"strings"
)

// indexSkipNames is the set of directory names whose subtrees are skipped
// during scanning, indexing, and watching.
//
// Skipping is for INDEXING ONLY. The data page tree shows everything —
// these directories remain visible to the user as a regular file browser.
//
// Adding entries here requires a high bar: a name must be (a) almost
// universally junk AND (b) impractical-to-large to index. Do NOT add
// names that might be legitimate user content in some contexts (e.g.
// dist/, build/, out/, target/ — these often hold user-meaningful
// artifacts and aren't always large).
//
// Each entry below is annotated with: what tool produces it, and the
// typical total size / file count we'd otherwise drag through FTS.
var indexSkipNames = map[string]bool{
	// Node.js / npm / yarn / pnpm per-project dependency directory.
	// Typical: 100MB–2GB, 10k–200k files per project.
	"node_modules": true,

	// Git repository metadata: objects, packfiles, refs, hooks.
	// Typical: 10MB–1GB, dominated by a few large packfiles plus
	// thousands of loose objects on busy repos.
	".git": true,

	// pnpm content-addressable package cache, shared across projects
	// on a machine.
	// Typical: 1–10GB, 100k+ files.
	".pnpm-store": true,

	// Python compiled bytecode cache, one per package directory.
	// Each is small but pervasive — every package subdirectory has
	// one, easily 1k+ .pyc files in a medium project.
	"__pycache__": true,

	// Git worktree directory (the convention used by this project's
	// own remote git workflow). Each child is a FULL checkout of the
	// parent repo, so descending into it indexes the entire repo a
	// second time per worktree.
	// Typical: parent-repo size × N worktrees — for a repo that has
	// node_modules expanded inside, easily +1GB and +100k files per
	// worktree.
	".worktrees": true,

	// Python virtual environment (the Poetry / uv / modern default
	// name). Pip-installed dependencies + interpreter binaries +
	// site-packages.
	// Typical: 100MB–2GB, 10k–50k files per env.
	".venv": true,

	// Same as .venv but without the leading dot — the name used by
	// Python's own `python -m venv venv` examples and most older
	// tutorials, still extremely common.
	// Typical: same as .venv (100MB–2GB, 10k–50k files).
	"venv": true,
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
