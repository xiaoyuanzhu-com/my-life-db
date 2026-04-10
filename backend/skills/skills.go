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
	// Path relative to .claude/skills/ in the data directory
	Path    string
	Content string
}

// All returns all bundled skills.
func All() []BundledSkill {
	return []BundledSkill{
		{Path: "create-agent/SKILL.md", Content: createAgentSkill},
	}
}

// Install writes all bundled skills to the user's data directory.
// Skills are written to <dataDir>/.claude/skills/ for Claude Code discovery.
// Existing files are overwritten to ensure they stay up to date.
func Install(dataDir string) {
	for _, skill := range All() {
		dest := filepath.Join(dataDir, ".claude", "skills", skill.Path)
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
