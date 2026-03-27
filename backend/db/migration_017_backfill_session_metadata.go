package db

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

func init() {
	RegisterMigration(Migration{
		Version:     17,
		Description: "Backfill working_dir, title, created_at for pre-ACP sessions from Claude session index files",
		Up: func(db *sql.DB) error {
			// Find sessions that need backfill (empty working_dir or title)
			rows, err := db.Query(
				`SELECT session_id, working_dir, title, created_at FROM agent_sessions
				 WHERE working_dir = '' OR title = '' OR created_at = 0`,
			)
			if err != nil {
				return err
			}

			type sessionRow struct {
				id         string
				workingDir string
				title      string
				createdAt  int64
			}
			var needsBackfill []sessionRow
			for rows.Next() {
				var s sessionRow
				if err := rows.Scan(&s.id, &s.workingDir, &s.title, &s.createdAt); err != nil {
					rows.Close()
					return err
				}
				needsBackfill = append(needsBackfill, s)
			}
			rows.Close()

			if len(needsBackfill) == 0 {
				log.Info().Msg("migration 17: no sessions need backfill")
				return nil
			}

			log.Info().Int("count", len(needsBackfill)).Msg("migration 17: sessions need backfill")

			// Build index: sessionID → index entry from all sessions-index.json files
			index := loadAllSessionIndexEntries()
			if len(index) == 0 {
				log.Info().Msg("migration 17: no session index entries found on disk, skipping backfill")
				return nil
			}

			log.Info().Int("indexEntries", len(index)).Msg("migration 17: loaded session index entries")

			// Update each session
			tx, err := db.Begin()
			if err != nil {
				return err
			}
			defer tx.Rollback()

			stmt, err := tx.Prepare(
				`UPDATE agent_sessions
				 SET working_dir = CASE WHEN working_dir = '' AND ? != '' THEN ? ELSE working_dir END,
				     title = CASE WHEN title = '' AND ? != '' THEN ? ELSE title END,
				     created_at = CASE WHEN created_at = 0 AND ? != 0 THEN ? ELSE created_at END
				 WHERE session_id = ?`,
			)
			if err != nil {
				return err
			}
			defer stmt.Close()

			updated := 0
			for _, s := range needsBackfill {
				entry, ok := index[s.id]
				if !ok {
					continue
				}

				workingDir := entry.projectPath
				title := bestTitle(entry)
				createdAt := parseCreatedAt(entry.created)

				_, err := stmt.Exec(
					workingDir, workingDir,
					title, title,
					createdAt, createdAt,
					s.id,
				)
				if err != nil {
					log.Warn().Err(err).Str("sessionId", s.id).Msg("migration 17: failed to update session")
					continue
				}
				updated++
			}

			log.Info().Int("updated", updated).Int("total", len(needsBackfill)).Msg("migration 17: backfill complete")
			return tx.Commit()
		},
	})
}

// sessionIndexEntry is a minimal struct for reading sessions-index.json.
// Defined here to avoid coupling the db package to the claude package.
type sessionIndexEntry struct {
	sessionID   string
	projectPath string
	customTitle string
	summary     string
	firstPrompt string
	created     string
}

// loadAllSessionIndexEntries scans ~/.claude/projects/*/sessions-index.json
// and returns a map of sessionID → entry.
func loadAllSessionIndexEntries() map[string]sessionIndexEntry {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		log.Warn().Err(err).Msg("migration 17: cannot get home directory")
		return nil
	}

	projectsDir := filepath.Join(homeDir, ".claude", "projects")
	dirEntries, err := os.ReadDir(projectsDir)
	if err != nil {
		log.Warn().Err(err).Msg("migration 17: cannot read ~/.claude/projects")
		return nil
	}

	result := make(map[string]sessionIndexEntry)

	for _, de := range dirEntries {
		if !de.IsDir() {
			continue
		}

		indexPath := filepath.Join(projectsDir, de.Name(), "sessions-index.json")
		data, err := os.ReadFile(indexPath)
		if err != nil {
			continue // no index file in this project dir
		}

		var idx struct {
			Entries []struct {
				SessionID   string `json:"sessionId"`
				ProjectPath string `json:"projectPath"`
				CustomTitle string `json:"customTitle"`
				Summary     string `json:"summary"`
				FirstPrompt string `json:"firstPrompt"`
				Created     string `json:"created"`
			} `json:"entries"`
		}
		if err := json.Unmarshal(data, &idx); err != nil {
			log.Warn().Err(err).Str("path", indexPath).Msg("migration 17: failed to parse session index")
			continue
		}

		for _, e := range idx.Entries {
			if e.SessionID == "" {
				continue
			}
			// First entry wins (avoid overwrites from duplicate entries)
			if _, exists := result[e.SessionID]; !exists {
				result[e.SessionID] = sessionIndexEntry{
					sessionID:   e.SessionID,
					projectPath: e.ProjectPath,
					customTitle: e.CustomTitle,
					summary:     e.Summary,
					firstPrompt: e.FirstPrompt,
					created:     e.Created,
				}
			}
		}
	}

	return result
}

// bestTitle picks the best available title for a session index entry.
// Priority: customTitle > summary > truncated firstPrompt.
func bestTitle(e sessionIndexEntry) string {
	if e.customTitle != "" {
		return e.customTitle
	}
	if e.summary != "" {
		return e.summary
	}
	if e.firstPrompt != "" {
		// Truncate to first line, max 100 chars
		prompt := e.firstPrompt
		if idx := strings.IndexByte(prompt, '\n'); idx >= 0 {
			prompt = prompt[:idx]
		}
		prompt = strings.TrimSpace(prompt)
		if len(prompt) > 100 {
			prompt = prompt[:97] + "..."
		}
		return prompt
	}
	return ""
}

// parseCreatedAt converts the "created" string from session index to epoch ms.
// The index uses ISO 8601 format (e.g., "2025-01-15T10:30:00.000Z").
func parseCreatedAt(created string) int64 {
	if created == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, created)
	if err != nil {
		t, err = time.Parse(time.RFC3339, created)
		if err != nil {
			return 0
		}
	}
	return t.UnixMilli()
}
