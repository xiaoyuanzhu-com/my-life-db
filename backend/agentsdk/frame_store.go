package agentsdk

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// FrameStore persists raw ACP frames to per-session JSONL files on disk.
// Each session has a dedicated writer goroutine that drains a bounded channel
// and appends frames to <appDataDir>/agent_frames/<sessionID>.jsonl.
//
// Design:
//   - Append is non-blocking: sends to a buffered channel (capacity 256).
//     On overflow, the frame is dropped with a warning log to avoid blocking
//     the hot path.
//   - Load reads the JSONL file; individual corrupt lines are skipped with a
//     warning but don't abort the load.
//   - Delete removes the JSONL file when a session is deleted.
//   - Close drains all writer channels and closes all open files.
type FrameStore struct {
	baseDir string

	mu      sync.Mutex
	writers map[string]*sessionWriter // sessionID → writer
}

type sessionWriter struct {
	ch     chan []byte
	done   chan struct{}
}

// NewFrameStore creates a FrameStore that saves JSONL files under
// <appDataDir>/agent_frames/.
func NewFrameStore(appDataDir string) *FrameStore {
	return &FrameStore{
		baseDir: filepath.Join(appDataDir, "agent_frames"),
		writers: make(map[string]*sessionWriter),
	}
}

// Append enqueues a frame for the given session. Non-blocking: if the
// channel is full the frame is silently dropped (with a warning log).
func (s *FrameStore) Append(sessionID string, frame []byte) {
	w := s.getOrCreateWriter(sessionID)
	select {
	case w.ch <- frame:
	default:
		log.Info().Str("sessionId", sessionID).Msg("frame_store: channel full, dropping frame")
	}
}

// Load reads all frames for the given session from disk.
// Returns nil, nil if the file does not exist.
// Individual lines that fail JSON parse are skipped with a warning.
func (s *FrameStore) Load(sessionID string) ([][]byte, error) {
	path := s.filePath(sessionID)
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var frames [][]byte
	scanner := bufio.NewScanner(f)
	// Allow up to 10 MB per line to handle large frames
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 10*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		// Validate that the line is valid JSON before accepting it.
		// This skips a partial trailing line from a mid-write crash.
		if !json.Valid(line) {
			log.Info().Str("sessionId", sessionID).Int("lineLen", len(line)).Msg("frame_store: skipping invalid JSON line during load")
			continue
		}
		// Copy to avoid aliasing from scanner's internal buffer
		cp := make([]byte, len(line))
		copy(cp, line)
		frames = append(frames, cp)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	log.Info().Str("sessionId", sessionID).Int("frameCount", len(frames)).Msg("frame_store: loaded frames from disk")
	return frames, nil
}

// Delete removes the JSONL file for the given session.
// A non-existent file is not an error.
func (s *FrameStore) Delete(sessionID string) {
	// Stop the writer (if any) before deleting the file.
	s.mu.Lock()
	w, ok := s.writers[sessionID]
	if ok {
		delete(s.writers, sessionID)
	}
	s.mu.Unlock()

	if ok {
		close(w.ch)
		<-w.done
	}

	path := s.filePath(sessionID)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		log.Info().Err(err).Str("sessionId", sessionID).Msg("frame_store: failed to delete frame file")
	}
}

// Close drains all writer goroutines and closes all open files.
// Should be called during server shutdown.
func (s *FrameStore) Close() {
	s.mu.Lock()
	writers := make(map[string]*sessionWriter, len(s.writers))
	for id, w := range s.writers {
		writers[id] = w
	}
	s.writers = make(map[string]*sessionWriter)
	s.mu.Unlock()

	for _, w := range writers {
		close(w.ch)
	}
	for _, w := range writers {
		<-w.done
	}
}

// filePath returns the path to the JSONL file for a session.
func (s *FrameStore) filePath(sessionID string) string {
	return filepath.Join(s.baseDir, sessionID+".jsonl")
}

// getOrCreateWriter returns (creating if necessary) the writer for a session.
func (s *FrameStore) getOrCreateWriter(sessionID string) *sessionWriter {
	s.mu.Lock()
	defer s.mu.Unlock()

	if w, ok := s.writers[sessionID]; ok {
		return w
	}

	w := &sessionWriter{
		ch:   make(chan []byte, 256),
		done: make(chan struct{}),
	}
	s.writers[sessionID] = w

	go s.runWriter(sessionID, w)
	return w
}

// runWriter is the per-session background writer goroutine.
func (s *FrameStore) runWriter(sessionID string, w *sessionWriter) {
	defer close(w.done)

	// Ensure directory exists.
	if err := os.MkdirAll(s.baseDir, 0755); err != nil {
		log.Info().Err(err).Str("sessionId", sessionID).Msg("frame_store: failed to create agent_frames dir")
		// Drain channel so Append callers don't block on full channel after this.
		for range w.ch {
		}
		return
	}

	path := s.filePath(sessionID)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		log.Info().Err(err).Str("sessionId", sessionID).Msg("frame_store: failed to open JSONL file")
		for range w.ch {
		}
		return
	}
	defer f.Close()

	for frame := range w.ch {
		// Write frame + newline. Each frame must be valid JSON (it always is,
		// coming from the ACP SDK). We write without buffering so a crash
		// doesn't lose frames that were already sent to the channel.
		if _, err := f.Write(append(frame, '\n')); err != nil {
			log.Info().Err(err).Str("sessionId", sessionID).Msg("frame_store: write error")
		}
	}
}
