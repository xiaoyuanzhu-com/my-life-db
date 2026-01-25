package sdk

import (
	"errors"
	"fmt"
)

var (
	// ErrNotConnected is returned when operations are attempted before connecting
	ErrNotConnected = errors.New("not connected: call Connect() first")

	// ErrAlreadyConnected is returned when Connect is called twice
	ErrAlreadyConnected = errors.New("already connected")

	// ErrCLINotFound is returned when the Claude CLI binary cannot be found
	ErrCLINotFound = errors.New("claude CLI not found")

	// ErrStreamingModeRequired is returned when an operation requires streaming mode
	ErrStreamingModeRequired = errors.New("this operation requires streaming mode")

	// ErrConnectionClosed is returned when the connection has been closed
	ErrConnectionClosed = errors.New("connection closed")

	// ErrTimeout is returned when an operation times out
	ErrTimeout = errors.New("operation timed out")
)

// CLIConnectionError represents a connection error to the CLI
type CLIConnectionError struct {
	Message string
	Cause   error
}

func (e *CLIConnectionError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("CLI connection error: %s: %v", e.Message, e.Cause)
	}
	return fmt.Sprintf("CLI connection error: %s", e.Message)
}

func (e *CLIConnectionError) Unwrap() error {
	return e.Cause
}

// MessageParseError represents an error parsing a message
type MessageParseError struct {
	Message string
	Data    []byte
	Cause   error
}

func (e *MessageParseError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("message parse error: %s: %v", e.Message, e.Cause)
	}
	return fmt.Sprintf("message parse error: %s", e.Message)
}

func (e *MessageParseError) Unwrap() error {
	return e.Cause
}

// ControlRequestError represents an error in control request handling
type ControlRequestError struct {
	RequestID string
	Subtype   string
	Message   string
	Cause     error
}

func (e *ControlRequestError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("control request error [%s/%s]: %s: %v", e.RequestID, e.Subtype, e.Message, e.Cause)
	}
	return fmt.Sprintf("control request error [%s/%s]: %s", e.RequestID, e.Subtype, e.Message)
}

func (e *ControlRequestError) Unwrap() error {
	return e.Cause
}

// CLIVersionError represents a version mismatch with the CLI
type CLIVersionError struct {
	CurrentVersion  string
	RequiredVersion string
}

func (e *CLIVersionError) Error() string {
	return fmt.Sprintf("CLI version %s is below minimum required version %s", e.CurrentVersion, e.RequiredVersion)
}

// HookCallbackError represents an error in hook callback execution
type HookCallbackError struct {
	HookEvent  HookEvent
	CallbackID string
	Message    string
	Cause      error
}

func (e *HookCallbackError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("hook callback error [%s/%s]: %s: %v", e.HookEvent, e.CallbackID, e.Message, e.Cause)
	}
	return fmt.Sprintf("hook callback error [%s/%s]: %s", e.HookEvent, e.CallbackID, e.Message)
}

func (e *HookCallbackError) Unwrap() error {
	return e.Cause
}
