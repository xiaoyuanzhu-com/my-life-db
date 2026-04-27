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
	if url, _ := agent["url"].(string); url != "http://localhost:12345/api/agent/mcp" {
		t.Errorf("url = %q, want http://localhost:12345/api/agent/mcp", url)
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
	if url, _ := agent["url"].(string); url != "http://localhost:4321/api/agent/mcp" {
		t.Errorf("url = %q, want port 4321 reflected", url)
	}
}

func TestInstallClientConfig_MCPJSONOverwrites(t *testing.T) {
	// Simulate a stale file written with the old port; the server owns this
	// file and must overwrite it on every startup so port changes propagate.
	dir := t.TempDir()
	stalePath := filepath.Join(dir, ".mcp.json")
	if err := os.WriteFile(stalePath, []byte(`{"mcpServers":{"mylifedb-builtin":{"type":"http","url":"http://localhost:9999/api/agent/mcp"}}}`), 0644); err != nil {
		t.Fatalf("seed stale .mcp.json: %v", err)
	}

	InstallClientConfig(dir, 12345)

	mcp := readJSON(t, stalePath)
	servers, _ := mcp["mcpServers"].(map[string]any)
	agent, _ := servers["mylifedb-builtin"].(map[string]any)
	if url, _ := agent["url"].(string); url != "http://localhost:12345/api/agent/mcp" {
		t.Errorf("stale port not overwritten — url = %q", url)
	}
}

func TestInstallClientConfig_CreatesSettingsFromScratch(t *testing.T) {
	dir := t.TempDir()
	InstallClientConfig(dir, 12345)

	settings := readJSON(t, filepath.Join(dir, ".claude", "settings.local.json"))
	perms, _ := settings["permissions"].(map[string]any)
	allow, _ := perms["allow"].([]any)

	got := map[string]bool{}
	for _, v := range allow {
		if s, ok := v.(string); ok {
			got[s] = true
		}
	}
	for _, want := range mcpToolAllowlist {
		if !got[want] {
			t.Errorf("allow list missing %q — got: %v", want, allow)
		}
	}
}

func TestInstallClientConfig_PreservesUserEntries(t *testing.T) {
	dir := t.TempDir()
	settingsDir := filepath.Join(dir, ".claude")
	if err := os.MkdirAll(settingsDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(settingsDir, "settings.local.json")
	seed := `{
  "permissions": {
    "allow": [
      "Bash(npm run *)",
      "mcp__explore__createPost"
    ]
  }
}`
	if err := os.WriteFile(path, []byte(seed), 0644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	InstallClientConfig(dir, 12345)

	settings := readJSON(t, path)
	perms, _ := settings["permissions"].(map[string]any)
	allow, _ := perms["allow"].([]any)

	got := map[string]bool{}
	for _, v := range allow {
		if s, ok := v.(string); ok {
			got[s] = true
		}
	}

	// User entries must survive.
	if !got["Bash(npm run *)"] {
		t.Errorf("user entry 'Bash(npm run *)' was dropped")
	}
	// Existing MCP entry should NOT be duplicated.
	count := 0
	for _, v := range allow {
		if s, _ := v.(string); s == "mcp__explore__createPost" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("mcp__explore__createPost appears %d times, want 1 — allow: %v", count, allow)
	}
	// MyLifeDB tools must be added.
	if !got["mcp__mylifedb-builtin__validateAgent"] {
		t.Errorf("mcp__mylifedb-builtin__validateAgent was not added")
	}
}

func TestInstallClientConfig_DropsRenamedAllowEntries(t *testing.T) {
	// Old installs put mcp__mylifedb-agent__validateAgent on the allow list.
	// After the rename to mylifedb-builtin, the stale entry must be dropped.
	dir := t.TempDir()
	settingsDir := filepath.Join(dir, ".claude")
	if err := os.MkdirAll(settingsDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(settingsDir, "settings.local.json")
	seed := `{"permissions":{"allow":["mcp__mylifedb-agent__validateAgent","Bash(npm run *)"]}}`
	if err := os.WriteFile(path, []byte(seed), 0644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	InstallClientConfig(dir, 12345)

	settings := readJSON(t, path)
	perms, _ := settings["permissions"].(map[string]any)
	allow, _ := perms["allow"].([]any)
	for _, v := range allow {
		if s, _ := v.(string); s == "mcp__mylifedb-agent__validateAgent" {
			t.Errorf("renamed entry mcp__mylifedb-agent__validateAgent should have been dropped, got: %v", allow)
		}
	}
}

func TestInstallClientConfig_Idempotent(t *testing.T) {
	dir := t.TempDir()
	InstallClientConfig(dir, 12345)
	first := readJSON(t, filepath.Join(dir, ".claude", "settings.local.json"))

	InstallClientConfig(dir, 12345)
	second := readJSON(t, filepath.Join(dir, ".claude", "settings.local.json"))

	if !reflect.DeepEqual(first, second) {
		t.Errorf("settings changed on second install — want idempotent\nfirst:  %v\nsecond: %v", first, second)
	}
}

func TestInstall_WritesToAllUserHomeRoots(t *testing.T) {
	// Install must land the skill in every user-home root so each agent CLI
	// (Claude Code, Codex/Gemini/opencode via alias, Qwen) can discover it
	// regardless of CWD.
	home := t.TempDir()
	t.Setenv("HOME", home)

	dataDir := t.TempDir()
	Install(dataDir)

	wantPaths := []string{
		filepath.Join(home, ".claude/skills/create-auto-agent/SKILL.md"),
		filepath.Join(home, ".agents/skills/create-auto-agent/SKILL.md"),
		filepath.Join(home, ".qwen/skills/create-auto-agent/SKILL.md"),
	}
	for _, p := range wantPaths {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("expected skill at %s, got error: %v", p, err)
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

func TestInstall_RemovesRenamedFolderInUserHome(t *testing.T) {
	// Old user-home installs wrote ~/.claude/skills/create-agent/. After the
	// rename, Install must remove that folder so Claude Code doesn't load both
	// the old and new skill.
	home := t.TempDir()
	t.Setenv("HOME", home)

	stale := filepath.Join(home, ".claude/skills/create-agent")
	if err := os.MkdirAll(stale, 0755); err != nil {
		t.Fatalf("seed mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stale, "SKILL.md"), []byte("stale"), 0644); err != nil {
		t.Fatalf("seed write: %v", err)
	}

	Install(t.TempDir())

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("renamed skill folder %s should have been removed; stat err = %v", stale, err)
	}
}

func TestInstallClientConfig_HandlesInvalidSettingsJSON(t *testing.T) {
	// If settings.local.json is corrupted (not valid JSON), InstallClientConfig
	// must still produce a valid file rather than aborting or panicking.
	dir := t.TempDir()
	settingsDir := filepath.Join(dir, ".claude")
	_ = os.MkdirAll(settingsDir, 0755)
	path := filepath.Join(settingsDir, "settings.local.json")
	if err := os.WriteFile(path, []byte("this is not json {"), 0644); err != nil {
		t.Fatalf("seed corrupt: %v", err)
	}

	InstallClientConfig(dir, 12345)

	settings := readJSON(t, path)
	perms, _ := settings["permissions"].(map[string]any)
	allow, _ := perms["allow"].([]any)
	if len(allow) == 0 {
		t.Errorf("allow list empty after recovery — got: %v", settings)
	}
}
