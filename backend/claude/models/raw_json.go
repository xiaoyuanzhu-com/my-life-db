package models

import "encoding/json"

// RawJSON holds the original JSON bytes for passthrough serialization.
// When MarshalJSON is called, the raw bytes are returned as-is.
type RawJSON struct {
	Raw json.RawMessage `json:"-"`
}
