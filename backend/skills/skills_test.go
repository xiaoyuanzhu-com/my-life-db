package skills

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("parse %s: %v — body: %s", path, err, string(body))
	}
	return out
}

func TestInstallClientConfig_WritesMCPJSON(t *testing.T) {
	dir := t.TempDir()
	InstallClientConfig(dir, 12345)

	mcp := readJSON(t, filepath.Join(dir, ".mcp.json"))
	servers, _ := mcp["mcpServers"].(map[string]any)
	agent, _ := servers["mylifedb-builtin"].(map[string]any)
	if agent == nil {
		t.Fatalf("mylifedb-builtin not registered, got: %v", mcp)
	}
	if url, _ := agent["url"].(string); url != "http://localhost:12345/api/mcp" {
		t.Errorf("url = %q, want http://localhost:12345/api/mcp", url)
	}
	if typ, _ := agent["type"].(string); typ != "http" {
		t.Errorf("type = %q, want http", typ)
	}
}

func TestInstallClientConfig_MCPJSONReflectsPort(t *testing.T) {
	dir := t.TempDir()
	InstallClientConfig(dir, 4321)

	mcp := readJSON(t, filepath.Join(dir, ".mcp.json"))
	servers, _ := mcp["mcpServers"].(map[string]any)
	agent, _ := servers["mylifedb-builtin"].(map[string]any)
	if url, _ := agent["url"].(string); url != "http://localhost:4321/api/mcp" {
		t.Errorf("url = %q, want port 4321 reflected", url)
	}
}

func TestInstallClientConfig_MCPJSONOverwrites(t *testing.T) {
	// Simulate a stale file written with the old port; the server owns this
	// file and must overwrite it on every startup so port changes propagate.
	dir := t.TempDir()
	stalePath := filepath.Join(dir, ".mcp.json")
	if err := os.WriteFile(stalePath, []byte(`{"mcpServers":{"mylifedb-builtin":{"type":"http","url":"http://localhost:9999/api/mcp"}}}`), 0644); err != nil {
		t.Fatalf("seed stale .mcp.json: %v", err)
	}

	InstallClientConfig(dir, 12345)

	mcp := readJSON(t, stalePath)
	servers, _ := mcp["mcpServers"].(map[string]any)
	agent, _ := servers["mylifedb-builtin"].(map[string]any)
	if url, _ := agent["url"].(string); url != "http://localhost:12345/api/mcp" {
		t.Errorf("stale port not overwritten — url = %q", url)
	}
}

func TestInstallClientConfig_MCPJSONPrunesLegacyServer(t *testing.T) {
	// Old installs registered "mylifedb-agent" alongside "mylifedb-builtin".
	// After the central-MCP refactor only one server is hosted; the legacy
	// key must be pruned so .mcp.json doesn't accumulate dead entries.
	// User-added servers must survive.
	dir := t.TempDir()
	stalePath := filepath.Join(dir, ".mcp.json")
	seed := `{"mcpServers":{
		"mylifedb-agent":{"type":"http","url":"http://localhost:9999/api/agent/mcp"},
		"my-other-mcp":{"type":"http","url":"http://localhost:7777/x"}
	}}`
	if err := os.WriteFile(stalePath, []byte(seed), 0644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	InstallClientConfig(dir, 12345)

	mcp := readJSON(t, stalePath)
	servers, _ := mcp["mcpServers"].(map[string]any)
	if _, ok := servers["mylifedb-agent"]; ok {
		t.Errorf("legacy server mylifedb-agent should have been pruned, got: %v", servers)
	}
	if _, ok := servers["my-other-mcp"]; !ok {
		t.Errorf("user-added server my-other-mcp must survive, got: %v", servers)
	}
}

func TestInstallClientConfig_Idempotent(t *testing.T) {
	dir := t.TempDir()
	InstallClientConfig(dir, 12345)
	first := readJSON(t, filepath.Join(dir, ".mcp.json"))

	InstallClientConfig(dir, 12345)
	second := readJSON(t, filepath.Join(dir, ".mcp.json"))

	if !reflect.DeepEqual(first, second) {
		t.Errorf(".mcp.json changed on second install — want idempotent\nfirst:  %v\nsecond: %v", first, second)
	}
}

func TestInstall_WritesToAllUserHomeRoots(t *testing.T) {
	// Install must land the skill in every active user-home root. Claude Code,
	// Codex (native), Gemini (alias), and opencode (alias) all read
	// ~/.agents/skills/, so we don't write a separate ~/.claude/skills/ copy —
	// it would surface as a duplicate skill entry in Claude Code.
	home := t.TempDir()
	t.Setenv("HOME", home)

	dataDir := t.TempDir()
	Install(dataDir)

	wantPaths := []string{
		filepath.Join(home, ".agents/skills/create-auto-agent/SKILL.md"),
		filepath.Join(home, ".qwen/skills/create-auto-agent/SKILL.md"),
	}
	for _, p := range wantPaths {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("expected skill at %s, got error: %v", p, err)
		}
	}

	// Belt-and-suspenders: ~/.claude/skills/ must NOT be written to.
	notWanted := filepath.Join(home, ".claude/skills/create-auto-agent/SKILL.md")
	if _, err := os.Stat(notWanted); !os.IsNotExist(err) {
		t.Errorf("~/.claude/skills/ should not be written to (Claude Code reads ~/.agents/skills/), but %s exists; err = %v", notWanted, err)
	}
}

func TestInstall_WipesLegacyClaudeUserHomeRoot(t *testing.T) {
	// Past installs wrote ~/.claude/skills/<bundled>/. Install must remove the
	// current bundled name (and the renamed predecessor) from there so Claude
	// Code stops listing the same skill twice once it picks it up via the
	// agent-skills alias.
	home := t.TempDir()
	t.Setenv("HOME", home)

	for _, name := range []string{"create-auto-agent", "create-agent"} {
		seedDir := filepath.Join(home, ".claude/skills", name)
		if err := os.MkdirAll(seedDir, 0755); err != nil {
			t.Fatalf("seed mkdir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(seedDir, "SKILL.md"), []byte("stale"), 0644); err != nil {
			t.Fatalf("seed write: %v", err)
		}
	}

	Install(t.TempDir())

	for _, name := range []string{"create-auto-agent", "create-agent"} {
		path := filepath.Join(home, ".claude/skills", name)
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("legacy claude-home skill folder %s should have been removed; stat err = %v", path, err)
		}
	}
}

func TestInstall_WipesLegacyDataDirRoot(t *testing.T) {
	// Past installs wrote bundled skills to <dataDir>/.agents/skills/. Install
	// must remove those (and renamed-name predecessors) so the move to
	// user-home is sticky across restarts.
	home := t.TempDir()
	t.Setenv("HOME", home)

	dataDir := t.TempDir()
	legacy := filepath.Join(dataDir, ".agents/skills")

	// Seed both the current bundled name and the renamed predecessor.
	for _, name := range []string{"create-auto-agent", "create-agent"} {
		seedDir := filepath.Join(legacy, name)
		if err := os.MkdirAll(seedDir, 0755); err != nil {
			t.Fatalf("seed mkdir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(seedDir, "SKILL.md"), []byte("stale"), 0644); err != nil {
			t.Fatalf("seed write: %v", err)
		}
	}

	Install(dataDir)

	for _, name := range []string{"create-auto-agent", "create-agent"} {
		path := filepath.Join(legacy, name)
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("legacy skill folder %s should have been removed; stat err = %v", path, err)
		}
	}
}

