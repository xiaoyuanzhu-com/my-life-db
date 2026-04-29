package agentsdk

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// claudeCodeCleanupForever is the value written to ~/.claude/settings.json
// for cleanupPeriodDays. Claude Code's default is 30 days, after which JSONL
// transcripts under ~/.claude/projects/ are auto-deleted. We pin it to a
// large finite number rather than 0, because cleanupPeriodDays: 0 has a
// known bug that disables transcript persistence entirely (anthropics/claude-code#23710).
const claudeCodeCleanupForever = 999999

// EnsureRetentionConfigs writes per-agent retention settings so that session
// transcripts are kept indefinitely on disk. MyLifeDB uses the on-disk files
// as the durable record of every agent conversation, so we must guarantee
// the underlying CLIs do not auto-delete them.
//
// Idempotent. Safe to call on every server startup. Failures for one agent
// do not block the others — each is best-effort and logged.
//
// Must be called AFTER any code that does a full overwrite of the same
// settings.json files (server.go writes ~/.gemini/settings.json and
// ~/.qwen/settings.json on startup), because this function does
// read-merge-write on top of whatever is already there.
func EnsureRetentionConfigs() {
	ensureClaudeCodeRetention()
	ensureCodexRetention()
	ensureQwenRetention()
	ensureGeminiRetention()
	ensureOpencodeRetention()
}

// ensureClaudeCodeRetention sets cleanupPeriodDays in ~/.claude/settings.json
// to a large finite number so JSONL transcripts under ~/.claude/projects/
// are not auto-deleted (default would be 30 days).
//
// This file may contain user-authored keys (extraKnownMarketplaces,
// enabledPlugins, theme, etc.) that we must NOT clobber, so we read-merge-write
// with an atomic rename to survive crashes mid-write.
func ensureClaudeCodeRetention() {
	home, err := os.UserHomeDir()
	if err != nil {
		log.Warn().Err(err).Msg("retention: cannot resolve home dir; skipping claude_code")
		return
	}
	dir := filepath.Join(home, ".claude")
	path := filepath.Join(dir, "settings.json")

	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Warn().Err(err).Str("path", dir).Msg("retention: failed to create ~/.claude")
		return
	}

	settings := map[string]any{}
	body, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		log.Warn().Err(err).Str("path", path).Msg("retention: failed to read claude settings.json; skipping to avoid clobber")
		return
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &settings); err != nil {
			log.Warn().Err(err).Str("path", path).Msg("retention: claude settings.json is not valid JSON; skipping to avoid clobber")
			return
		}
	}

	if existing, ok := settings["cleanupPeriodDays"]; ok {
		// Already set high enough — leave it alone.
		if n, ok := numericGTE(existing, claudeCodeCleanupForever); ok && n {
			log.Info().Str("agent", "claude_code").Interface("cleanupPeriodDays", existing).Msg("retention: already configured")
			return
		}
	}
	settings["cleanupPeriodDays"] = claudeCodeCleanupForever

	if err := writeJSONAtomic(path, settings); err != nil {
		log.Warn().Err(err).Str("path", path).Msg("retention: failed to write claude settings.json")
		return
	}
	log.Info().Str("agent", "claude_code").Int("cleanupPeriodDays", claudeCodeCleanupForever).Msg("retention: configured")
}

// ensureCodexRetention is a no-op: codex (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
// has no auto-cleanup mechanism. Sessions persist indefinitely by default.
// See: openai/codex#6015 (retention period is requested but unimplemented),
// openai/codex#6526 (automatic session cleanup is requested but unimplemented).
// Nothing for MyLifeDB to configure here.
func ensureCodexRetention() {
	log.Info().Str("agent", "codex").Msg("retention: forever by default; no config needed")
}

// ensureQwenRetention is a no-op for the primary store: qwen-code does not
// auto-delete session JSONLs under ~/.qwen/tmp/<project_hash>/ (QwenLM/qwen-code#1902).
// Defensively force episodicSummary.autoCleanup=false in case future versions
// enable it (see QwenLM/qwen-code#497 RFC for the episodic summary subsystem).
//
// Note: server.go writes ~/.qwen/settings.json with full overwrite earlier in
// startup; this function MUST run after that to avoid being clobbered.
func ensureQwenRetention() {
	home := os.Getenv("QWEN_HOME")
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			log.Warn().Err(err).Msg("retention: cannot resolve home dir; skipping qwen")
			return
		}
		home = filepath.Join(userHome, ".qwen")
	}
	if err := os.MkdirAll(home, 0700); err != nil {
		log.Warn().Err(err).Str("path", home).Msg("retention: failed to create qwen home")
		return
	}
	path := filepath.Join(home, "settings.json")

	settings, err := readJSONOrEmpty(path)
	if err != nil {
		log.Warn().Err(err).Str("path", path).Msg("retention: failed to read qwen settings.json; skipping to avoid clobber")
		return
	}

	mergeNested(settings, []string{"episodicSummary", "autoCleanup"}, false)

	if err := writeJSONAtomic(path, settings); err != nil {
		log.Warn().Err(err).Str("path", path).Msg("retention: failed to write qwen settings.json")
		return
	}
	log.Info().Str("agent", "qwen").Msg("retention: configured (episodicSummary.autoCleanup=false; transcripts forever by default)")
}

// ensureGeminiRetention disables sessionRetention in ~/.gemini/settings.json.
// Gemini CLI is the only ACP agent in our set that auto-deletes sessions:
// general.sessionRetention.{enabled:true, maxAge:"30d"} is the default, so
// without this override we'd lose sessions older than 30 days.
//
// Note: server.go writes ~/.gemini/settings.json with full overwrite earlier
// in startup (to force gemini-api-key auth); this function MUST run after
// that to avoid being clobbered.
func ensureGeminiRetention() {
	home := os.Getenv("GEMINI_HOME")
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			log.Warn().Err(err).Msg("retention: cannot resolve home dir; skipping gemini")
			return
		}
		home = filepath.Join(userHome, ".gemini")
	}
	if err := os.MkdirAll(home, 0700); err != nil {
		log.Warn().Err(err).Str("path", home).Msg("retention: failed to create gemini home")
		return
	}
	path := filepath.Join(home, "settings.json")

	settings, err := readJSONOrEmpty(path)
	if err != nil {
		log.Warn().Err(err).Str("path", path).Msg("retention: failed to read gemini settings.json; skipping to avoid clobber")
		return
	}

	mergeNested(settings, []string{"general", "sessionRetention", "enabled"}, false)

	if err := writeJSONAtomic(path, settings); err != nil {
		log.Warn().Err(err).Str("path", path).Msg("retention: failed to write gemini settings.json")
		return
	}
	log.Info().Str("agent", "gemini").Msg("retention: configured (general.sessionRetention.enabled=false)")
}

// ensureOpencodeRetention is a no-op: opencode stores sessions in a SQLite
// database at ~/.local/share/opencode/opencode.db with no auto-cleanup
// (anomalyco/opencode#4980). Sessions persist indefinitely by default.
// Nothing for MyLifeDB to configure here.
func ensureOpencodeRetention() {
	log.Info().Str("agent", "opencode").Msg("retention: forever by default; no config needed")
}

// readJSONOrEmpty returns the parsed JSON object at path, or an empty map if
// the file does not exist. Returns an error if the file exists but is unreadable
// or contains invalid JSON — callers must treat that as "skip; do not overwrite",
// since blindly overwriting could destroy user data.
func readJSONOrEmpty(path string) (map[string]any, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	if len(body) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

// mergeNested sets settings[path[0]][path[1]]...[path[n-1]] = value, creating
// intermediate maps as needed. If an intermediate path element exists but is
// not a map, it is replaced with a fresh map (we own these keys; if a prior
// run or user wrote a non-object, our merge wins for the namespace we control).
func mergeNested(settings map[string]any, path []string, value any) {
	if len(path) == 0 {
		return
	}
	cur := settings
	for i, key := range path {
		if i == len(path)-1 {
			cur[key] = value
			return
		}
		next, ok := cur[key].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[key] = next
		}
		cur = next
	}
}

// writeJSONAtomic marshals settings as indented JSON and writes to path via
// a tmp-file + rename, so a crash mid-write cannot leave the file truncated.
// Mode 0600 — these files contain agent credentials and personal config.
func writeJSONAtomic(path string, settings map[string]any) error {
	body, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0600); err != nil {
		return fmt.Errorf("write tmp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		// Best-effort cleanup of tmp on rename failure.
		_ = os.Remove(tmp)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// numericGTE reports whether v is a numeric JSON value greater than or equal
// to threshold. JSON numbers from encoding/json land as float64; we accept
// int as well for completeness.
func numericGTE(v any, threshold int) (bool, bool) {
	switch n := v.(type) {
	case float64:
		return n >= float64(threshold), true
	case int:
		return n >= threshold, true
	case int64:
		return n >= int64(threshold), true
	case json.Number:
		i, err := n.Int64()
		if err == nil {
			return i >= int64(threshold), true
		}
		f, err := n.Float64()
		if err == nil {
			return f >= float64(threshold), true
		}
	}
	return false, false
}
