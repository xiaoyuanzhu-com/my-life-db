package vendors

import (
	"path/filepath"

	"github.com/xiaoyuanzhu-com/my-life-db/config"
)

// resolveFilePath converts a relative file path to absolute by joining with DataDir
// If the path is already absolute, returns it unchanged
func resolveFilePath(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	cfg := config.Get()
	return filepath.Join(cfg.UserDataDir, path)
}

// ASROptions holds options for speech recognition
type ASROptions struct {
	Model       string
	Diarization bool
}

// ASRSegment represents a speech recognition segment
type ASRSegment struct {
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Text    string  `json:"text"`
	Speaker string  `json:"speaker,omitempty"`
}

// ASRSpeaker represents speaker information with voice embedding
type ASRSpeaker struct {
	SpeakerID     string    `json:"speaker_id"`
	Embedding     []float32 `json:"embedding"`      // 512-dim voice embedding vector
	TotalDuration float64   `json:"total_duration"` // Total speaking time in seconds
	SegmentCount  int       `json:"segment_count"`  // Number of segments for this speaker
}

// ASRResponse represents speech recognition response
type ASRResponse struct {
	RequestID        string       `json:"request_id"`
	ProcessingTimeMs int          `json:"processing_time_ms"`
	Text             string       `json:"text"`
	Language         string       `json:"language"`
	Model            string       `json:"model"`
	Segments         []ASRSegment `json:"segments"`
	Speakers         []ASRSpeaker `json:"speakers,omitempty"` // Speaker embeddings when diarization enabled
	Error            string       `json:"error,omitempty"`
}
