package server

import (
	"os"
	"path/filepath"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SweepAgentAttachments deletes attachment staging directories older than
// maxAge. Returns the count of removed directories.
//
// Safe to call concurrently with live uploads/deletes — it operates at the
// directory level and never touches an in-progress upload's files directly.
// If the root doesn't exist yet, it's a no-op.
func SweepAgentAttachments(appDataDir string, maxAge time.Duration) (int, error) {
	root := filepath.Join(appDataDir, "tmp", "agent-uploads")
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}

	cutoff := time.Now().Add(-maxAge)
	removed := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		info, err := os.Stat(dir)
		if err != nil {
			log.Error().Err(err).Str("dir", dir).Msg("agent-attachments: stat failed during sweep")
			continue
		}
		if info.ModTime().Before(cutoff) {
			if err := os.RemoveAll(dir); err != nil {
				log.Error().Err(err).Str("dir", dir).Msg("agent-attachments: remove failed during sweep")
				continue
			}
			removed++
		}
	}
	if removed > 0 {
		log.Info().Int("removed", removed).Dur("maxAge", maxAge).Msg("agent-attachments: sweep complete")
	}
	return removed, nil
}
