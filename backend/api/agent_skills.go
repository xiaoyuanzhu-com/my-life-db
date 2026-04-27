package api

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"gopkg.in/yaml.v3"
)

// skillEntry is the wire shape for a single discovered skill.
type skillEntry struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Source      string `json:"source"`          // "bundled" | "user" | "project"
	Agent       string `json:"agent,omitempty"` // "" (any) | "claude_code" | "codex" | "gemini" | "cursor"
	Path        string `json:"path"`            // absolute path to SKILL.md
}

// skillFrontmatter is the subset of SKILL.md frontmatter we need.
// The full Agent Skills spec also has fields like license, allowed-tools,
// version — we only surface what the composer UI displays.
type skillFrontmatter struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
}

// skillRoot pairs a skill directory with its source label and agent affinity.
// agent="" means vendor-neutral (e.g. .agents/skills) — the skill applies to
// any agent.
type skillRoot struct {
	dir    string
	source string
	agent  string
}

// ListSkills walks the standard skill discovery directories, parses each
// SKILL.md frontmatter, and returns a flat list of skills.
//
// The optional ?workingDir= query param adds project-level scanning for that
// directory (matches what the agent runtime would actually load when launched
// with that cwd).
//
// GET /api/agent/skills
func (h *Handlers) ListSkills(c *gin.Context) {
	dataDir := h.server.Cfg().UserDataDir
	workingDir := strings.TrimSpace(c.Query("workingDir"))
	roots := skillRoots(dataDir, workingDir)

	// Dedup key is (name, agent) — a vendor-neutral "commit" and a
	// claude_code-specific "commit" are distinct skills the runtime would treat
	// independently. We walk in ascending precedence and let later entries
	// (project > user > bundled, specific path within tier) overwrite earlier
	// ones with the same key.
	type key struct{ name, agent string }
	byKey := map[key]skillEntry{}
	for _, r := range roots {
		entries, err := os.ReadDir(r.dir)
		if err != nil {
			// Missing directories are normal — most users won't have all of them.
			continue
		}
		for _, ent := range entries {
			if !ent.IsDir() {
				continue
			}
			skillPath := filepath.Join(r.dir, ent.Name(), "SKILL.md")
			data, err := os.ReadFile(skillPath)
			if err != nil {
				continue
			}
			fm, ok := parseSkillFrontmatter(data)
			if !ok {
				log.Debug().Str("path", skillPath).Msg("skipping skill without frontmatter")
				continue
			}
			name := fm.Name
			if name == "" {
				name = ent.Name()
			}
			byKey[key{name, r.agent}] = skillEntry{
				Name:        name,
				Description: fm.Description,
				Source:      r.source,
				Agent:       r.agent,
				Path:        skillPath,
			}
		}
	}

	out := make([]skillEntry, 0, len(byKey))
	for _, s := range byKey {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		if li, lj := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name); li != lj {
			return li < lj
		}
		// Within the same name, vendor-neutral first, then alphabetical agent.
		return out[i].Agent < out[j].Agent
	})

	c.JSON(http.StatusOK, gin.H{"skills": out})
}

// skillRoots returns the skill directories to scan, in ascending precedence
// order (later wins). Covers the conventions used by Claude Code, Codex,
// Gemini CLI, and Cursor, plus the vendor-neutral .agents/skills convention.
//
// dataDir hosts MyLifeDB's bundled skills (installed by backend/skills).
// workingDir is the composer's currently selected working directory; when set,
// project-level scans are added so the UI reflects what the agent runtime
// would actually load when launched with that cwd.
func skillRoots(dataDir, workingDir string) []skillRoot {
	roots := []skillRoot{
		// Bundled — lowest precedence. Server-owned dir under USER_DATA_DIR.
		{dir: filepath.Join(dataDir, ".agents", "skills"), source: "bundled"},
	}

	if home, err := os.UserHomeDir(); err == nil {
		// User-level. Vendor-neutral first, then specific tools — specific wins
		// on (name, agent) collision, but since the vendor-neutral entries have
		// agent="" they never collide with vendor-specific ones anyway.
		roots = append(roots,
			skillRoot{dir: filepath.Join(home, ".agents", "skills"), source: "user"},
			skillRoot{dir: filepath.Join(home, ".codex", "skills"), source: "user", agent: "codex"},
			skillRoot{dir: filepath.Join(home, ".gemini", "skills"), source: "user", agent: "gemini"},
			skillRoot{dir: filepath.Join(home, ".cursor", "skills"), source: "user", agent: "cursor"},
			skillRoot{dir: filepath.Join(home, ".claude", "skills"), source: "user", agent: "claude_code"},
		)
	}

	// Project-level — highest precedence. Only scanned when the composer has
	// a working directory selected.
	if workingDir != "" {
		roots = append(roots,
			skillRoot{dir: filepath.Join(workingDir, ".agents", "skills"), source: "project"},
			skillRoot{dir: filepath.Join(workingDir, ".gemini", "skills"), source: "project", agent: "gemini"},
			skillRoot{dir: filepath.Join(workingDir, ".claude", "skills"), source: "project", agent: "claude_code"},
		)
	}

	return roots
}

// parseSkillFrontmatter extracts the YAML frontmatter from a SKILL.md file.
// Returns ok=false if the file has no frontmatter delimiters, signalling that
// the file is not a valid Agent Skill manifest and should be skipped.
func parseSkillFrontmatter(data []byte) (skillFrontmatter, bool) {
	text := string(data)
	if !strings.HasPrefix(text, "---") {
		return skillFrontmatter{}, false
	}
	rest := strings.TrimPrefix(text, "---")
	rest = strings.TrimLeft(rest, "\r\n")
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return skillFrontmatter{}, false
	}
	yamlBody := rest[:end]
	var fm skillFrontmatter
	if err := yaml.Unmarshal([]byte(yamlBody), &fm); err != nil {
		return skillFrontmatter{}, false
	}
	return fm, true
}
