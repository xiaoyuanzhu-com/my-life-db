package skills

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

//go:embed create-auto-agent.md
var createAutoAgentSkill string

// BundledSkill represents a skill shipped with MyLifeDB.
type BundledSkill struct {
	// Path relative to the skills root (e.g., "create-auto-agent/SKILL.md")
	Path    string
	Content string
}

// All returns all bundled skills.
func All() []BundledSkill {
	return []BundledSkill{
		{Path: "create-auto-agent/SKILL.md", Content: createAutoAgentSkill},
	}
}

// renamedSkillFolders are folders left by past installs under a previous skill
// name. Removed from every active and legacy root on Install so renamed skills
// don't linger and load twice.
var renamedSkillFolders = []string{
	"create-agent",
}

// legacyInstallRoots are directories MyLifeDB used to install skills into but
// no longer does. Bundled skills (current and renamed names) are removed from
// these roots on every Install so the move is sticky across restarts.
//
// Stale roots:
//   - <dataDir>/.agents/skills — replaced by the user-home install set; the
//     data dir varies per deployment, so workspace-level install never
//     covered the user's interactive sessions.
func legacyInstallRoots(dataDir string) []string {
	return []string{
		filepath.Join(dataDir, ".agents/skills"),
	}
}

// Install writes all bundled skills to user-home discovery directories so that
// every supported agent CLI finds them regardless of CWD.
//
// Three roots cover all five agents MyLifeDB spawns:
//   - ~/.claude/skills — Claude Code (native discovery path; see note below).
//   - ~/.agents/skills — Codex (native), Gemini (alias), opencode (alias),
//     and any future Claude Code build that picks up the agent-skills alias.
//   - ~/.qwen/skills   — Qwen Code (no alias support).
//
// Why both ~/.claude/skills and ~/.agents/skills for Claude Code:
//
// We previously installed only to ~/.agents/skills/ on the assumption that
// Claude Code resolves skills there via the agent-skills.io alias (the same
// mechanism Codex/Gemini use). That assumption was wrong for the Claude Code
// versions actual users run — bundled skills written only to ~/.agents/skills/
// were not discovered, and the create-auto-agent skill was missing from
// sessions, breaking the in-app "create an auto agent" flow.
//
// The defensive install (writing to BOTH paths) restores discovery on every
// Claude Code build we have seen in the wild. If a future Claude Code build
// dedupes cross-root skills and surfaces a duplicate "create-auto-agent"
// entry, the fix is to drop the ~/.agents copy at that point — but until then,
// visibility wins over the cosmetic duplicate-entry risk: a missing skill
// silently breaks user workflows, while a duplicate entry is at worst a
// harmless extra row in the skill picker.
//
// Existing files are overwritten to keep skills up to date.
func Install(dataDir string) {
	home, err := os.UserHomeDir()
	if err != nil {
		log.Error().Err(err).Msg("cannot resolve user home; skipping skill install")
		return
	}
	roots := []string{
		filepath.Join(home, ".claude/skills"),
		filepath.Join(home, ".agents/skills"),
		filepath.Join(home, ".qwen/skills"),
	}

	// Wipe bundled skills from legacy roots so the move to user-home is sticky.
	for _, root := range legacyInstallRoots(dataDir) {
		for _, skill := range All() {
			path := filepath.Join(root, filepath.Dir(skill.Path))
			if err := os.RemoveAll(path); err != nil {
				log.Warn().Err(err).Str("path", path).Msg("failed to remove legacy bundled skill")
			}
		}
		for _, old := range renamedSkillFolders {
			path := filepath.Join(root, old)
			if err := os.RemoveAll(path); err != nil {
				log.Warn().Err(err).Str("path", path).Msg("failed to remove renamed skill folder from legacy root")
			}
		}
	}

	for _, root := range roots {
		for _, old := range renamedSkillFolders {
			path := filepath.Join(root, old)
			if err := os.RemoveAll(path); err != nil {
				log.Warn().Err(err).Str("path", path).Msg("failed to remove renamed skill folder")
			}
		}

		for _, skill := range All() {
			dest := filepath.Join(root, skill.Path)
			dir := filepath.Dir(dest)

			if err := os.MkdirAll(dir, 0755); err != nil {
				log.Error().Err(err).Str("path", dest).Msg("failed to create skill directory")
				continue
			}

			if err := os.WriteFile(dest, []byte(skill.Content), 0644); err != nil {
				log.Error().Err(err).Str("path", dest).Msg("failed to write bundled skill")
				continue
			}

			log.Debug().Str("path", dest).Msg("bundled skill installed")
		}
	}
}

// legacyMCPServers are .mcp.json server keys written by older MyLifeDB versions.
// Pruned on every install so .mcp.json doesn't accumulate stale entries while
// leaving anything the user added themselves untouched.
var legacyMCPServers = []string{
	// Pre-refactor split-server name.
	"mylifedb-agent",
}

// InstallClientConfig writes <dataDir>/.mcp.json so the built-in mylifedb
// MCP server is registered alongside any user-added servers. The same file is
// the source of truth for the composer UI and for buildSessionMcpServers,
// which converts every enabled entry into ACP McpServer wire shape at session
// creation. The mylifedb-builtin entry is merged: user-added servers survive,
// legacy MyLifeDB keys are pruned, and `disabled` flags toggled from the UI
// are preserved across restarts.
func InstallClientConfig(dataDir string, port int) {
	installMCPJSON(dataDir, port)
}

func installMCPJSON(dataDir string, port int) {
	path := filepath.Join(dataDir, ".mcp.json")

	// Merge rather than overwrite: preserve any user-added servers and any
	// `disabled` flags toggled from the composer UI. Only the mylifedb-builtin
	// entry's `type` and `url` are server-owned (so changing PORT is reflected
	// on next start without manual edits).
	var doc map[string]any
	if existing, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(existing, &doc); err != nil {
			log.Warn().Err(err).Str("path", path).Msg("existing .mcp.json is invalid JSON, rewriting from scratch")
			doc = nil
		}
	}
	if doc == nil {
		doc = map[string]any{}
	}
	servers, _ := doc["mcpServers"].(map[string]any)
	if servers == nil {
		servers = map[string]any{}
		doc["mcpServers"] = servers
	}
	mld, _ := servers["mylifedb-builtin"].(map[string]any)
	if mld == nil {
		mld = map[string]any{}
	}
	mld["type"] = "http"
	mld["url"] = fmt.Sprintf("http://localhost:%d/api/mcp", port)
	mld["timeout"] = 3_600_000           // 1h — Claude Code (ms)
	mld["connect_timeout_sec"] = 3600    // 1h — Codex (seconds)
	mld["initialize_timeout_sec"] = 3600 // 1h — Codex (seconds)
	servers["mylifedb-builtin"] = mld

	// Drop legacy server keys that previous MyLifeDB versions wrote so
	// .mcp.json doesn't accumulate stale duplicate entries. User-added
	// servers are not in the list and are left alone.
	for _, key := range legacyMCPServers {
		delete(servers, key)
	}

	body, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		log.Error().Err(err).Msg("failed to marshal .mcp.json")
		return
	}
	if err := os.WriteFile(path, append(body, '\n'), 0644); err != nil {
		log.Error().Err(err).Str("path", path).Msg("failed to write .mcp.json")
		return
	}
	log.Debug().Str("path", path).Msg(".mcp.json installed")
}

