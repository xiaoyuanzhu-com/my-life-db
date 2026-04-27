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
	Source      string `json:"source"` // "bundled" | "user" | "project"
	Path        string `json:"path"`   // absolute path to SKILL.md
}

// skillFrontmatter is the subset of SKILL.md frontmatter we need.
// The full Agent Skills spec also has fields like license, allowed-tools,
// version — we only surface what the composer UI displays.
type skillFrontmatter struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
}

// skillRoot pairs a skill directory with its source label.
type skillRoot struct {
	dir    string
	source string
}

// ListSkills walks the standard skill discovery directories, parses each
// SKILL.md frontmatter, and returns a flat list of skills.
//
// GET /api/agent/skills
func (h *Handlers) ListSkills(c *gin.Context) {
	dataDir := h.server.Cfg().UserDataDir
	roots := skillRoots(dataDir)

	// Latest source wins on name collision, mirroring how Claude Code resolves
	// skill precedence (project > user > bundled). We walk in ascending priority
	// and let later entries overwrite earlier ones.
	byName := map[string]skillEntry{}
	for _, r := range roots {
		entries, err := os.ReadDir(r.dir)
		if err != nil {
			// Missing directories are normal — skill dirs are optional.
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
			byName[name] = skillEntry{
				Name:        name,
				Description: fm.Description,
				Source:      r.source,
				Path:        skillPath,
			}
		}
	}

	out := make([]skillEntry, 0, len(byName))
	for _, s := range byName {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})

	c.JSON(http.StatusOK, gin.H{"skills": out})
}

// skillRoots returns the skill directories to scan, in ascending precedence
// order (later wins). Mirrors the install paths in backend/skills/skills.go.
func skillRoots(dataDir string) []skillRoot {
	roots := []skillRoot{
		// Bundled skills are installed to .agents/skills along with the embedded
		// create-agent skill. Treat this dir as "bundled" since the server owns it.
		{dir: filepath.Join(dataDir, ".agents", "skills"), source: "bundled"},
	}
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, skillRoot{
			dir:    filepath.Join(home, ".claude", "skills"),
			source: "user",
		})
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
