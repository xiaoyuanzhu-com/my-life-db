package skills

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

//go:embed create-agent.md
var createAgentSkill string

// BundledSkill represents a skill shipped with MyLifeDB.
type BundledSkill struct {
	// Path relative to the skills root (e.g., "create-agent/SKILL.md")
	Path    string
	Content string
}

// All returns all bundled skills.
func All() []BundledSkill {
	return []BundledSkill{
		{Path: "create-agent/SKILL.md", Content: createAgentSkill},
	}
}

// Install writes all bundled skills to discovery directories.
// Skills are installed to:
//   - <dataDir>/.agents/skills/ — cross-client Agent Skills standard (agentskills.io)
//   - ~/.claude/skills/ — Claude Code CLI discovery
//
// Existing files are overwritten to ensure they stay up to date.
func Install(dataDir string) {
	roots := []string{
		filepath.Join(dataDir, ".agents/skills"),
	}

	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, filepath.Join(home, ".claude/skills"))
	}

	for _, root := range roots {
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

// mcpToolAllowlist names the MyLifeDB MCP tools that Claude Code sessions
// started in the data directory should be pre-allowed to call. Kept in sync
// with the tools actually exposed by the backend.
var mcpToolAllowlist = []string{
	"mcp__mylifedb-agent__validateAgent",
	"mcp__explore__createPost",
	"mcp__explore__listPosts",
	"mcp__explore__addComment",
	"mcp__explore__addTags",
}

// InstallClientConfig writes Claude Code client-discovery files into the user's
// data directory so that CLI sessions started inside USER_DATA_DIR connect to
// MyLifeDB's MCP servers without any manual setup. Two files are managed:
//
//   - <dataDir>/.mcp.json — registers the mylifedb-agent MCP server at the
//     configured port. Fully server-owned (overwritten each startup) so that
//     changing PORT is reflected without manual edits.
//   - <dataDir>/.claude/settings.local.json — adds MyLifeDB's MCP tools to the
//     permissions.allow list. Merged (not replaced) so any user-added entries
//     survive.
func InstallClientConfig(dataDir string, port int) {
	installMCPJSON(dataDir, port)
	mergeAllowlist(dataDir)
}

func installMCPJSON(dataDir string, port int) {
	path := filepath.Join(dataDir, ".mcp.json")

	// Merge rather than overwrite: preserve any user-added servers and any
	// `disabled` flags toggled from the composer UI. Only the mylifedb-agent
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
	mld, _ := servers["mylifedb-agent"].(map[string]any)
	if mld == nil {
		mld = map[string]any{}
	}
	mld["type"] = "http"
	mld["url"] = fmt.Sprintf("http://localhost:%d/api/agent/mcp", port)
	servers["mylifedb-agent"] = mld

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

func mergeAllowlist(dataDir string) {
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
	// and keep the file diff-friendly across restarts.
	existing, _ := perms["allow"].([]any)
	present := map[string]bool{}
	for _, v := range existing {
		if s, ok := v.(string); ok {
			present[s] = true
		}
	}
	changed := false
	for _, tool := range mcpToolAllowlist {
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
