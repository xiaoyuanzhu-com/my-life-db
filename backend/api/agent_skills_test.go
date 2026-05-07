package api

import (
	"os"
	"path/filepath"
	"testing"
)

// writeSkill seeds a SKILL.md with minimal frontmatter so parseSkillFrontmatter
// accepts it.
func writeSkill(t *testing.T, dir, name, description string) {
	t.Helper()
	folder := filepath.Join(dir, name)
	if err := os.MkdirAll(folder, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", folder, err)
	}
	body := "---\nname: " + name + "\ndescription: " + description + "\n---\n\nbody"
	if err := os.WriteFile(filepath.Join(folder, "SKILL.md"), []byte(body), 0644); err != nil {
		t.Fatalf("write SKILL.md: %v", err)
	}
}

// walkSkillRoots mirrors the dedup loop in ListSkills so we can test the dedup
// logic without standing up a Gin server. Kept in lockstep with ListSkills.
func walkSkillRoots(roots []skillRoot, bundled map[string]struct{}) []skillEntry {
	type key struct{ name, agent string }
	byKey := map[key]skillEntry{}
	for _, r := range roots {
		entries, err := os.ReadDir(r.dir)
		if err != nil {
			continue
		}
		for _, ent := range entries {
			if !ent.IsDir() {
				continue
			}
			if r.agent != "" && r.source == "user" {
				if _, isBundled := bundled[ent.Name()]; isBundled {
					continue
				}
			}
			skillPath := filepath.Join(r.dir, ent.Name(), "SKILL.md")
			data, err := os.ReadFile(skillPath)
			if err != nil {
				continue
			}
			fm, ok := parseSkillFrontmatter(data)
			if !ok {
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
	return out
}

func TestBundledSkillNames_IncludesCreateAutoAgent(t *testing.T) {
	// The composer dedup relies on this set covering every skill backend/skills
	// installs to multiple roots. If a new bundled skill is added but its name
	// doesn't make it into this set, the composer will show duplicate rows.
	got := bundledSkillNames()
	if _, ok := got["create-auto-agent"]; !ok {
		t.Errorf("bundledSkillNames missing create-auto-agent: %v", got)
	}
}

func TestListSkills_DedupesBundledSkillAcrossAgentRoots(t *testing.T) {
	// backend/skills installs the same create-auto-agent SKILL.md to
	// ~/.agents/skills/ (vendor-neutral) AND ~/.claude/skills/ (Claude Code's
	// native discovery path). Without dedup the composer shows two rows for
	// the same bundled skill — one "any agent", one "claude_code" — which is
	// what this test guards against.
	home := t.TempDir()
	agentsDir := filepath.Join(home, ".agents/skills")
	claudeDir := filepath.Join(home, ".claude/skills")
	writeSkill(t, agentsDir, "create-auto-agent", "bundled, vendor-neutral copy")
	writeSkill(t, claudeDir, "create-auto-agent", "bundled, claude-specific copy")

	roots := []skillRoot{
		{dir: agentsDir, source: "user"},                         // vendor-neutral
		{dir: claudeDir, source: "user", agent: "claude_code"},   // claude-specific
	}
	out := walkSkillRoots(roots, bundledSkillNames())

	if len(out) != 1 {
		t.Fatalf("expected 1 entry after dedup, got %d: %+v", len(out), out)
	}
	if out[0].Agent != "" {
		t.Errorf("expected vendor-neutral entry to be kept (agent=\"\"), got agent=%q", out[0].Agent)
	}
	if out[0].Name != "create-auto-agent" {
		t.Errorf("name = %q, want create-auto-agent", out[0].Name)
	}
}

func TestListSkills_KeepsNonBundledClaudeSkill(t *testing.T) {
	// Skills the user adds to ~/.claude/skills/ that aren't in our bundled
	// set must always surface — the dedup filter is a narrow special case
	// for our own multi-root installs, not a blanket hide-everything-claude-
	// specific rule.
	home := t.TempDir()
	claudeDir := filepath.Join(home, ".claude/skills")
	writeSkill(t, claudeDir, "user-custom-skill", "user's own skill")

	roots := []skillRoot{
		{dir: claudeDir, source: "user", agent: "claude_code"},
	}
	out := walkSkillRoots(roots, bundledSkillNames())

	if len(out) != 1 {
		t.Fatalf("expected 1 entry, got %d: %+v", len(out), out)
	}
	if out[0].Name != "user-custom-skill" {
		t.Errorf("name = %q, want user-custom-skill", out[0].Name)
	}
	if out[0].Agent != "claude_code" {
		t.Errorf("agent = %q, want claude_code", out[0].Agent)
	}
}

func TestListSkills_KeepsProjectScopedBundledNameMatch(t *testing.T) {
	// Project-level skills (under workingDir/.claude/skills) share folder
	// names with our bundled skills only by coincidence; they're a different
	// SKILL.md authored for the project. Don't suppress them — the filter is
	// scoped to source="user" exactly so project entries fall through.
	dir := t.TempDir()
	writeSkill(t, dir, "create-auto-agent", "project's own override")

	roots := []skillRoot{
		{dir: dir, source: "project", agent: "claude_code"},
	}
	out := walkSkillRoots(roots, bundledSkillNames())

	if len(out) != 1 {
		t.Fatalf("expected project-scoped skill to surface, got %d entries", len(out))
	}
	if out[0].Source != "project" {
		t.Errorf("source = %q, want project", out[0].Source)
	}
}
