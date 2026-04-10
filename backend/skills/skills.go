package skills

import (
	_ "embed"
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
