// Package transport provides the low-level communication layer for the Claude SDK.
package transport

import (
	"context"
)

// Transport is the interface for communication with Claude CLI.
// Implementations handle the actual I/O (subprocess, mock, etc.)
type Transport interface {
	// Connect establishes the connection to Claude CLI
	Connect(ctx context.Context) error

	// Write sends data to Claude CLI's stdin
	Write(data string) error

	// ReadMessages returns a channel that yields raw JSON messages from stdout
	ReadMessages() <-chan []byte

	// Errors returns a channel that yields errors from the transport
	Errors() <-chan error

	// EndInput closes the stdin stream (signals EOF to Claude)
	EndInput() error

	// Close terminates the connection and cleans up resources
	Close() error

	// IsConnected returns whether the transport is currently connected
	IsConnected() bool

	// SignalShutdown marks the transport as shutting down.
	// This should be called early in the shutdown sequence so that
	// expected errors (like process exit from SIGINT) are logged
	// at debug level instead of error level.
	SignalShutdown()
}
