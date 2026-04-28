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
//   - ~/.claude/skills — Claude Code reads ~/.agents/skills/ as well
//     (verified empirically — it lists skills found there with no `agent`
//     key, the same way the agentskills.io alias works for Codex/Gemini).
//     Writing the same skill to both made every Claude Code session show
//     two identical entries.
func legacyInstallRoots(dataDir string) []string {
	roots := []string{
		filepath.Join(dataDir, ".agents/skills"),
	}
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, filepath.Join(home, ".claude/skills"))
	}
	return roots
}

// Install writes all bundled skills to user-home discovery directories so that
// every supported agent CLI finds them regardless of CWD.
//
// Two roots cover all five agents MyLifeDB spawns:
//   - ~/.agents/skills — Claude Code, Codex (native), Gemini (alias),
//     opencode (alias)
//   - ~/.qwen/skills   — Qwen Code (no alias support)
//
// Existing files are overwritten to keep skills up to date.
func Install(dataDir string) {
	home, err := os.UserHomeDir()
	if err != nil {
		log.Error().Err(err).Msg("cannot resolve user home; skipping skill install")
		return
	}
	roots := []string{
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

// legacyAllowlistEntries are tool-permission strings written by older MyLifeDB
// versions that no longer exist after the MCP refactor. Removed from
// settings.local.json on every merge so they don't linger as dead allows.
// Add to this list when a tool is renamed or removed; entries can be deleted
// once they're old enough that no live install still has them.
var legacyAllowlistEntries = []string{
	// Pre-refactor split-server names (replaced by mylifedb-builtin).
	"mcp__mylifedb-agent__validateAgent",
	"mcp__explore__createPost",
	"mcp__explore__deletePost",
	"mcp__explore__listPosts",
	"mcp__explore__addComment",
	"mcp__explore__addTags",
}

// legacyMCPServers are .mcp.json server keys written by older MyLifeDB versions.
// Pruned on every install so .mcp.json doesn't accumulate stale entries while
// leaving anything the user added themselves untouched.
var legacyMCPServers = []string{
	// Pre-refactor split-server name.
	"mylifedb-agent",
}

// InstallClientConfig writes Claude Code client-discovery files into the user's
// data directory so that CLI sessions started inside USER_DATA_DIR connect to
// MyLifeDB's MCP server without any manual setup. Two files are managed:
//
//   - <dataDir>/.mcp.json — registers the mylifedb-builtin MCP server at the
//     configured port. Merged so user-added servers survive; legacy MyLifeDB
//     keys are pruned.
//   - <dataDir>/.claude/settings.local.json — adds MyLifeDB's MCP tool names
//     (passed in `allowlist`, derived from the live registry) to
//     permissions.allow. Merged so user-added entries survive; legacy
//     MyLifeDB-prefixed entries are pruned.
//
// `allowlist` should be a slice of `mcp__<server>__<tool>` strings, typically
// from `mcp.Registry.AllowlistEntries()`.
func InstallClientConfig(dataDir string, port int, allowlist []string) {
	installMCPJSON(dataDir, port)
	mergeAllowlist(dataDir, allowlist)
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

func mergeAllowlist(dataDir string, allowlist []string) {
	path := filepath.Join(dataDir, ".claude", "settings.local.json")

	// Read any existing settings so we preserve user-added entries.
	var settings map[string]any
	if existing, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(existing, &settings); err != nil {
			log.Warn().Err(err).Str("path", path).Msg("existing settings.local.json is invalid JSON, rewriting from scratch")
			settings = nil
		}
	}
	if settings == nil {
		settings = map[string]any{}
	}

	perms, _ := settings["permissions"].(map[string]any)
	if perms == nil {
		perms = map[string]any{}
		settings["permissions"] = perms
	}

	// Normalize existing allow list into a set so we only append missing entries
	// and keep the file diff-friendly across restarts. Drop legacy MyLifeDB
	// entries so old per-server tool names don't linger after a rename.
	// User-added entries (anything not in the legacy list and not in the live
	// allowlist) are preserved untouched.
	legacy := map[string]bool{}
	for _, s := range legacyAllowlistEntries {
		legacy[s] = true
	}
	existing, _ := perms["allow"].([]any)
	present := map[string]bool{}
	filtered := existing[:0]
	changed := false
	for _, v := range existing {
		if s, ok := v.(string); ok && legacy[s] {
			changed = true
			continue
		}
		filtered = append(filtered, v)
		if s, ok := v.(string); ok {
			present[s] = true
		}
	}
	existing = filtered
	for _, tool := range allowlist {
		if !present[tool] {
			existing = append(existing, tool)
			present[tool] = true
			changed = true
		}
	}
	perms["allow"] = existing

	if !changed {
		log.Debug().Str("path", path).Msg("settings.local.json allow-list already up to date")
		return
	}

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		log.Error().Err(err).Str("path", path).Msg("failed to create .claude directory")
		return
	}
	body, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		log.Error().Err(err).Msg("failed to marshal settings.local.json")
		return
	}
	if err := os.WriteFile(path, append(body, '\n'), 0644); err != nil {
		log.Error().Err(err).Str("path", path).Msg("failed to write settings.local.json")
		return
	}
	log.Debug().Str("path", path).Msg("settings.local.json allow-list merged")
}
