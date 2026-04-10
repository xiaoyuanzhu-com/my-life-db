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

// skillRoots lists the directories where skills are installed.
// .agents/skills/ is the cross-client Agent Skills standard (agentskills.io),
// supported by 30+ clients including Claude Code, Codex, Cursor, Gemini CLI,
// Goose, GitHub Copilot, VS Code, and more.
var skillRoots = []string{
	".agents/skills",
}

// Install writes all bundled skills to the user's data directory.
// Skills are written to the standard .agents/skills/ directory for
// cross-client discovery (agentskills.io convention).
// Existing files are overwritten to ensure they stay up to date.
func Install(dataDir string) {
	for _, root := range skillRoots {
		for _, skill := range All() {
			dest := filepath.Join(dataDir, root, skill.Path)
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
