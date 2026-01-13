package fs

import "errors"

var (
	// ErrInvalidPath is returned when a path is invalid or malicious
	ErrInvalidPath = errors.New("invalid file path")

	// ErrExcludedPath is returned when a path matches exclusion patterns
	ErrExcludedPath = errors.New("path is excluded")

	// ErrFileNotFound is returned when a file doesn't exist
	ErrFileNotFound = errors.New("file not found")

	// ErrAlreadyProcessing is returned when a file is already being processed
	ErrAlreadyProcessing = errors.New("file is already being processed")

	// ErrFileTooLarge is returned when a file exceeds max size
	ErrFileTooLarge = errors.New("file too large")

	// ErrNotDirectory is returned when operation requires a directory
	ErrNotDirectory = errors.New("not a directory")

	// ErrIsDirectory is returned when operation requires a file
	ErrIsDirectory = errors.New("is a directory")
)
