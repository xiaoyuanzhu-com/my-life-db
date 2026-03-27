package db

import (
	"bufio"
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
		Version:     18,
		Description: "Backfill working_dir, title, created_at from JSONL session files",
		Up: func(db *sql.DB) error {
			// Find sessions that still need backfill
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
				log.Info().Msg("migration 18: no sessions need backfill")
				return nil
			}

			log.Info().Int("count", len(needsBackfill)).Msg("migration 18: sessions need backfill")

			// Build lookup set for quick matching
			needsMap := make(map[string]bool, len(needsBackfill))
			for _, s := range needsBackfill {
				needsMap[s.id] = true
			}

			// Scan all JSONL files under ~/.claude/projects/
			index := scanJSONLFiles(needsMap)
			if len(index) == 0 {
				log.Info().Msg("migration 18: no matching JSONL files found")
				return nil
			}

			log.Info().Int("matched", len(index)).Msg("migration 18: matched JSONL files to sessions")

			// Update sessions
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
				meta, ok := index[s.id]
				if !ok {
					continue
				}

				_, err := stmt.Exec(
					meta.workingDir, meta.workingDir,
					meta.title, meta.title,
					meta.createdAt, meta.createdAt,
					s.id,
				)
				if err != nil {
					log.Warn().Err(err).Str("sessionId", s.id).Msg("migration 18: failed to update session")
					continue
				}
				updated++
			}

			log.Info().Int("updated", updated).Int("total", len(needsBackfill)).Msg("migration 18: backfill complete")
			return tx.Commit()
		},
	})
}

type jsonlMeta struct {
	workingDir string
	title      string
	createdAt  int64
}

// scanJSONLFiles scans ~/.claude/projects/*/*.jsonl for session metadata.
// Only processes files whose session ID (filename without .jsonl) is in needsMap.
func scanJSONLFiles(needsMap map[string]bool) map[string]jsonlMeta {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		log.Warn().Err(err).Msg("migration 18: cannot get home directory")
		return nil
	}

	projectsDir := filepath.Join(homeDir, ".claude", "projects")
	projectDirs, err := os.ReadDir(projectsDir)
	if err != nil {
		log.Warn().Err(err).Msg("migration 18: cannot read ~/.claude/projects")
		return nil
	}

	result := make(map[string]jsonlMeta)

	for _, pd := range projectDirs {
		if !pd.IsDir() {
			continue
		}

		dirPath := filepath.Join(projectsDir, pd.Name())
		files, err := os.ReadDir(dirPath)
		if err != nil {
			continue
		}

		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}

			sessionID := strings.TrimSuffix(f.Name(), ".jsonl")
			if !needsMap[sessionID] {
				continue
			}

			// Skip if we already have this session from another project dir
			if _, exists := result[sessionID]; exists {
				continue
			}

			meta := parseJSONLForMeta(filepath.Join(dirPath, f.Name()))
			if meta != nil {
				result[sessionID] = *meta
			}
		}
	}

	return result
}

// parseJSONLForMeta reads a JSONL file and extracts working_dir, title, and created_at.
// Reads the entire file to find custom-title and summary messages which can appear anywhere.
func parseJSONLForMeta(path string) *jsonlMeta {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()

	var meta jsonlMeta
	var firstPrompt string
	var summary string

	reader := bufio.NewReader(file)
	lineNum := 0

	for {
		lineNum++
		lineBytes, err := reader.ReadBytes('\n')
		if err != nil {
			// Process last line
			if len(lineBytes) > 0 {
				processJSONLLine(lineBytes, lineNum, &meta, &firstPrompt, &summary)
			}
			break
		}
		processJSONLLine(lineBytes, lineNum, &meta, &firstPrompt, &summary)
	}

	// Pick best title: custom-title (already set in meta.title) > summary > first prompt
	if meta.title == "" {
		if summary != "" {
			meta.title = summary
		} else if firstPrompt != "" {
			meta.title = truncateTitle(firstPrompt)
		}
	}

	// If we got nothing useful, skip
	if meta.workingDir == "" && meta.title == "" && meta.createdAt == 0 {
		return nil
	}

	return &meta
}

// processJSONLLine extracts metadata from a single JSONL line.
func processJSONLLine(lineBytes []byte, lineNum int, meta *jsonlMeta, firstPrompt *string, summary *string) {
	line := strings.TrimSpace(string(lineBytes))
	if line == "" {
		return
	}

	// Minimal parse to extract just the fields we need
	var msg struct {
		Type         string `json:"type"`
		CWD          string `json:"cwd"`
		Timestamp    string `json:"timestamp"`
		CustomTitle  string `json:"customTitle"`
		Summary      string `json:"summary"`
		Message      *struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
		ToolUseResult    json.RawMessage `json:"toolUseResult"`
		IsCompactSummary bool            `json:"isCompactSummary"`
	}

	if err := json.Unmarshal([]byte(line), &msg); err != nil {
		return
	}

	// Extract cwd from first message that has it
	if meta.workingDir == "" && msg.CWD != "" {
		meta.workingDir = msg.CWD
	}

	// Extract created_at from first message timestamp
	if meta.createdAt == 0 && msg.Timestamp != "" {
		if t, err := time.Parse(time.RFC3339Nano, msg.Timestamp); err == nil {
			meta.createdAt = t.UnixMilli()
		} else if t, err := time.Parse(time.RFC3339, msg.Timestamp); err == nil {
			meta.createdAt = t.UnixMilli()
		}
	}

	// Custom title (highest priority, overwrites)
	if msg.Type == "custom-title" && msg.CustomTitle != "" {
		meta.title = msg.CustomTitle
	}

	// Summary
	if msg.Type == "summary" && msg.Summary != "" {
		*summary = msg.Summary
	}

	// First user prompt (lowest priority title)
	if *firstPrompt == "" && msg.Type == "user" && !msg.IsCompactSummary && len(msg.ToolUseResult) == 0 {
		*firstPrompt = extractPromptText(msg.Message)
	}
}

// extractPromptText extracts user text from a message content field.
func extractPromptText(msg *struct {
	Content json.RawMessage `json:"content"`
}) string {
	if msg == nil || len(msg.Content) == 0 {
		return ""
	}

	// Try string first
	var str string
	if err := json.Unmarshal(msg.Content, &str); err == nil {
		return str
	}

	// Try array of content blocks
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(msg.Content, &blocks); err == nil {
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				return b.Text
			}
		}
	}

	return ""
}

// truncateTitle truncates a prompt to use as a title.
func truncateTitle(s string) string {
	// Take first line
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		s = s[:idx]
	}
	s = strings.TrimSpace(s)
	if len(s) > 100 {
		s = s[:97] + "..."
	}
	return s
}
