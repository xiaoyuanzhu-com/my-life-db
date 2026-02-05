package fs

import (
	"path/filepath"
	"strings"
)

// Category represents a category of files/directories to exclude
type Category int

const (
	// CategoryHidden - dotfiles and dotdirs (.git, .hidden, etc.)
	CategoryHidden Category = 1 << iota

	// CategoryBackup - backup and temporary files (~file, *.bak, *.swp, etc.)
	CategoryBackup

	// CategoryVCS - version control directories (.git, .svn, .hg, etc.)
	CategoryVCS

	// CategoryIDE - IDE and editor configs (.idea, .vscode, etc.)
	CategoryIDE

	// CategoryDependencies - package manager directories (node_modules, vendor, etc.)
	CategoryDependencies

	// CategoryCache - build and runtime caches (__pycache__, .cache, etc.)
	CategoryCache

	// CategoryBuild - build output directories (dist, build, target, etc.)
	CategoryBuild

	// CategoryVirtualEnv - virtual environment directories (venv, .venv, etc.)
	CategoryVirtualEnv

	// CategoryOS - OS-generated files (.DS_Store, Thumbs.db, etc.)
	CategoryOS

	// CategoryLogs - log files and directories
	CategoryLogs

	// CategoryAppReserved - MyLifeDB-specific reserved paths (inbox, app at root)
	CategoryAppReserved
)

// Common presets for different use cases
const (
	// ExcludeNone - no exclusions
	ExcludeNone Category = 0

	// ExcludeDefault - standard exclusions for most filesystem operations
	ExcludeDefault = CategoryHidden | CategoryBackup | CategoryVCS | CategoryDependencies |
		CategoryCache | CategoryVirtualEnv | CategoryOS

	// ExcludeForTree - exclusions for tree API (library browsing)
	ExcludeForTree = CategoryHidden | CategoryDependencies | CategoryOS | CategoryAppReserved

	// ExcludeForIndexing - exclusions for file indexing/search
	ExcludeForIndexing = CategoryHidden | CategoryBackup | CategoryVCS | CategoryIDE |
		CategoryDependencies | CategoryCache | CategoryBuild | CategoryVirtualEnv |
		CategoryOS | CategoryLogs

	// ExcludeAll - all categories
	ExcludeAll = CategoryHidden | CategoryBackup | CategoryVCS | CategoryIDE |
		CategoryDependencies | CategoryCache | CategoryBuild | CategoryVirtualEnv |
		CategoryOS | CategoryLogs | CategoryAppReserved
)

// PathFilter handles file/directory exclusion checks
type PathFilter struct {
	exclusions Category
}

// NewPathFilter creates a new PathFilter with the specified exclusion categories
func NewPathFilter(exclusions Category) *PathFilter {
	return &PathFilter{exclusions: exclusions}
}

// DefaultPathFilter returns a PathFilter with default exclusions
func DefaultPathFilter() *PathFilter {
	return NewPathFilter(ExcludeDefault)
}

// IsExcluded checks if a path should be excluded based on any path component
func (f *PathFilter) IsExcluded(path string) bool {
	// Check each component of the path
	parts := strings.Split(filepath.ToSlash(path), "/")
	for i, part := range parts {
		if part == "" || part == "." {
			continue
		}
		isRoot := i == 0
		if f.isExcludedName(part, isRoot) {
			return true
		}
	}
	return false
}

// IsExcludedEntry checks if a single directory entry should be excluded
// Use this when iterating directory contents for better performance
func (f *PathFilter) IsExcludedEntry(name string, atRoot bool) bool {
	return f.isExcludedName(name, atRoot)
}

// Directories that are hidden (start with .) but should not be excluded
var allowedHiddenNames = map[string]bool{
	".claude": true, // Claude Code agent definitions
}

// isExcludedName checks if a single name matches exclusion rules
func (f *PathFilter) isExcludedName(name string, atRoot bool) bool {
	lower := strings.ToLower(name)

	// Hidden files (starts with dot, but not "." itself)
	if f.exclusions&CategoryHidden != 0 {
		if strings.HasPrefix(name, ".") && name != "." && !allowedHiddenNames[lower] {
			return true
		}
	}

	// VCS directories
	if f.exclusions&CategoryVCS != 0 {
		if vcsNames[lower] {
			return true
		}
	}

	// IDE directories and files
	if f.exclusions&CategoryIDE != 0 {
		if ideNames[lower] {
			return true
		}
		if hasAnySuffix(lower, ideSuffixes) {
			return true
		}
	}

	// Backup and temporary files
	if f.exclusions&CategoryBackup != 0 {
		if strings.HasPrefix(name, "~") || strings.HasSuffix(name, "~") {
			return true
		}
		if hasAnySuffix(lower, backupSuffixes) {
			return true
		}
	}

	// Dependencies directories
	if f.exclusions&CategoryDependencies != 0 {
		if dependencyNames[lower] {
			return true
		}
	}

	// Cache directories and files
	if f.exclusions&CategoryCache != 0 {
		if cacheNames[lower] {
			return true
		}
		if hasAnySuffix(lower, cacheSuffixes) {
			return true
		}
	}

	// Build output directories
	if f.exclusions&CategoryBuild != 0 {
		if buildNames[lower] {
			return true
		}
		if hasAnySuffix(lower, buildSuffixes) {
			return true
		}
	}

	// Virtual environment directories
	if f.exclusions&CategoryVirtualEnv != 0 {
		if venvNames[lower] {
			return true
		}
	}

	// OS-generated files
	if f.exclusions&CategoryOS != 0 {
		if osNames[lower] {
			return true
		}
		if hasAnyPrefix(name, osPrefixes) {
			return true
		}
		if hasAnySuffix(lower, osSuffixes) {
			return true
		}
	}

	// Log files and directories
	if f.exclusions&CategoryLogs != 0 {
		if logNames[lower] {
			return true
		}
		if hasAnySuffix(lower, logSuffixes) {
			return true
		}
	}

	// App-reserved paths (only at root level)
	if f.exclusions&CategoryAppReserved != 0 && atRoot {
		if appReservedNames[lower] {
			return true
		}
	}

	return false
}

// Helper functions
func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

func hasAnySuffix(s string, suffixes []string) bool {
	for _, suf := range suffixes {
		if strings.HasSuffix(s, suf) {
			return true
		}
	}
	return false
}

// =============================================================================
// Exclusion patterns organized by category
// =============================================================================

// Version Control Systems
var vcsNames = map[string]bool{
	".git":    true,
	".svn":    true,
	".hg":     true,
	".bzr":    true,
	"cvs":     true,
	".fossil": true,
	"_darcs":  true,
}

// IDE and Editor configurations
var ideNames = map[string]bool{
	// JetBrains
	".idea": true,
	// Visual Studio Code
	".vscode": true,
	// Visual Studio
	".vs": true,
	// Eclipse
	".project":   true,
	".classpath": true,
	".settings":  true,
	// Xcode
	".xcworkspace":  true,
	".xcuserdata":   true,
	"xcuserdata":    true,
	"xcshareddata":  true,
	"*.xcodeproj":   true,
	"*.xcworkspace": true,
	// Sublime Text
	".sublime-project": true,
	".sublime-workspace": true,
	// Vim
	".vim":     true,
	".nvim":    true,
	".exrc":    true,
	".viminfo": true,
	// Emacs
	".emacs.d":    true,
	".emacs.desktop": true,
	// Spyder
	".spyproject": true,
	// Fleet
	".fleet": true,
	// Cursor
	".cursor": true,
}

var ideSuffixes = []string{
	".suo",
	".user",
	".userosscache",
	".sln.docstates",
}

// Backup and temporary files
var backupSuffixes = []string{
	".bak",
	".backup",
	".swp",
	".swo",
	".swn",
	".tmp",
	".temp",
	".orig",
	".rej",
	".old",
}

// Package manager / Dependencies
var dependencyNames = map[string]bool{
	// JavaScript/Node
	"node_modules":   true,
	"bower_components": true,
	"jspm_packages":   true,
	".npm":            true,
	".yarn":           true,
	".pnpm-store":     true,
	// Go
	"vendor": true,
	// PHP
	// "vendor" already included
	// Ruby
	"bundle": true,
	// Rust
	".cargo": true,
	// Java
	".m2":     true,
	".gradle": true,
	// iOS/macOS
	"pods":       true,
	"carthage":   true,
	".cocoapods": true,
	// .NET
	"packages": true,
	// Python
	".eggs": true,
	"site-packages": true,
	// Dart/Flutter
	".dart_tool": true,
	".pub-cache": true,
	// Elixir
	"deps": true,
}

// Cache directories and files
var cacheNames = map[string]bool{
	// General
	".cache":       true,
	"__pycache__":  true,
	// Python
	".pytest_cache": true,
	".mypy_cache":   true,
	".ruff_cache":   true,
	".tox":          true,
	".nox":          true,
	".coverage":     true,
	".hypothesis":   true,
	// JavaScript
	".eslintcache":    true,
	".stylelintcache": true,
	".parcel-cache":   true,
	".sass-cache":     true,
	".turbo":          true,
	// Next.js / Nuxt
	".next":  true,
	".nuxt":  true,
	".output": true,
	// Gradle
	".gradle": true,
	// Terraform
	".terraform": true,
	// Go
	".gocache": true,
	// Rust
	".rustup": true,
	// Ruby
	".bundle": true,
}

var cacheSuffixes = []string{
	".pyc",
	".pyo",
	".pyd",
	".class",
}

// Build output directories
var buildNames = map[string]bool{
	"dist":    true,
	"build":   true,
	"out":     true,
	"output":  true,
	"target":  true,
	"bin":     true,
	"obj":     true,
	"_build":  true,
	"release": true,
	"debug":   true,
	// CMake
	"cmake-build-debug":   true,
	"cmake-build-release": true,
}

var buildSuffixes = []string{
	// Python
	".egg-info",
	".egg",
	".whl",
	// Compiled binaries (be careful - these might be intentional)
	".so",
	".dylib",
	".dll",
	".o",
	".a",
	".lib",
	".exe",
	// Java
	".jar",
	".war",
	".ear",
}

// Virtual environments
var venvNames = map[string]bool{
	"venv":        true,
	".venv":       true,
	"env":         true,
	"virtualenv":  true,
	".virtualenv": true,
	".conda":      true,
	"conda-meta":  true,
	"envs":        true,
	// Node version managers
	".nvm":   true,
	".fnm":   true,
	// Ruby version managers
	".rbenv": true,
	".rvm":   true,
	// Python version managers
	".pyenv": true,
}

// OS-generated files
var osNames = map[string]bool{
	// macOS
	".ds_store":          true,
	".appledouble":       true,
	".lsoverride":        true,
	".spotlight-v100":    true,
	".trashes":           true,
	".fseventsd":         true,
	".temporaryitems":    true,
	".volumeicon.icns":   true,
	".appledb":           true,
	".appledesktop":      true,
	".apdisk":            true,
	"network trash folder": true,
	"temporary items":    true,
	".com.apple.timemachine.donotpresent": true,
	".documentrevisions-v100": true,
	// Windows
	"thumbs.db":        true,
	"ehthumbs.db":      true,
	"ehthumbs_vista.db": true,
	"desktop.ini":      true,
	"$recycle.bin":     true,
	"system volume information": true,
	"ntuser.dat":       true,
	// Linux
	".directory":    true,
	".trash-1000":   true,
	"lost+found":    true,
}

var osPrefixes = []string{
	// macOS resource forks
	"._",
	// Windows shortcuts and system files
	"~$",
}

var osSuffixes = []string{
	// Windows shortcuts
	".lnk",
	// macOS
	".localized",
}

// Log files and directories
var logNames = map[string]bool{
	"logs":     true,
	"log":      true,
	".log":     true,
}

var logSuffixes = []string{
	".log",
	"-debug.log",
	"-error.log",
}

// MyLifeDB App-reserved paths (only checked at root level)
var appReservedNames = map[string]bool{
	// No reserved paths - inbox and app are shown in library tree
}
