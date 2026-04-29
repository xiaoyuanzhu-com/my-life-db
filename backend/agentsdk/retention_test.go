package agentsdk

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// withFakeHome sets HOME (and the agent-specific overrides) to a temp dir
// for the duration of t.
func withFakeHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	// Avoid existing exports leaking into the test.
	t.Setenv("GEMINI_HOME", "")
	t.Setenv("QWEN_HOME", "")
	return dir
}

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal %s: %v\n%s", path, err, body)
	}
	return out
}

func TestEnsureClaudeCodeRetention_FreshFile(t *testing.T) {
	home := withFakeHome(t)
	ensureClaudeCodeRetention()

	got := readJSON(t, filepath.Join(home, ".claude", "settings.json"))
	if v, _ := got["cleanupPeriodDays"].(float64); int(v) != claudeCodeCleanupForever {
		t.Fatalf("cleanupPeriodDays = %v, want %d", got["cleanupPeriodDays"], claudeCodeCleanupForever)
	}
}

func TestEnsureClaudeCodeRetention_PreservesExistingKeys(t *testing.T) {
	home := withFakeHome(t)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	existing := map[string]any{
		"cleanupPeriodDays":                 30, // too low; should be raised
		"skipDangerousModePermissionPrompt": true,
		"enabledPlugins": map[string]any{
			"impeccable@impeccable": true,
		},
		"theme": "dark",
	}
	body, _ := json.MarshalIndent(existing, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), body, 0600); err != nil {
		t.Fatal(err)
	}

	ensureClaudeCodeRetention()

	got := readJSON(t, filepath.Join(dir, "settings.json"))
	if v, _ := got["cleanupPeriodDays"].(float64); int(v) != claudeCodeCleanupForever {
		t.Fatalf("cleanupPeriodDays = %v, want %d", got["cleanupPeriodDays"], claudeCodeCleanupForever)
	}
	if got["skipDangerousModePermissionPrompt"] != true {
		t.Fatalf("skipDangerousModePermissionPrompt clobbered: %v", got["skipDangerousModePermissionPrompt"])
	}
	if got["theme"] != "dark" {
		t.Fatalf("theme clobbered: %v", got["theme"])
	}
	plugins, ok := got["enabledPlugins"].(map[string]any)
	if !ok || plugins["impeccable@impeccable"] != true {
		t.Fatalf("enabledPlugins clobbered: %v", got["enabledPlugins"])
	}
}

func TestEnsureClaudeCodeRetention_AlreadyHighEnough(t *testing.T) {
	home := withFakeHome(t)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	existing := map[string]any{"cleanupPeriodDays": 999999}
	body, _ := json.MarshalIndent(existing, "", "  ")
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	statBefore, _ := os.Stat(path)

	ensureClaudeCodeRetention()

	got := readJSON(t, path)
	if v, _ := got["cleanupPeriodDays"].(float64); int(v) < claudeCodeCleanupForever {
		t.Fatalf("cleanupPeriodDays = %v, want >= %d", got["cleanupPeriodDays"], claudeCodeCleanupForever)
	}
	statAfter, _ := os.Stat(path)
	// We early-return when already high enough; mtime should be unchanged.
	if !statBefore.ModTime().Equal(statAfter.ModTime()) {
		t.Errorf("file was rewritten despite already-high cleanupPeriodDays")
	}
}

func TestEnsureClaudeCodeRetention_InvalidJSONIsLeftAlone(t *testing.T) {
	home := withFakeHome(t)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte("{this is not json"), 0600); err != nil {
		t.Fatal(err)
	}

	ensureClaudeCodeRetention()

	body, _ := os.ReadFile(path)
	if string(body) != "{this is not json" {
		t.Fatalf("invalid JSON file was clobbered: %s", body)
	}
}

func TestEnsureGeminiRetention_FreshFile(t *testing.T) {
	home := withFakeHome(t)
	ensureGeminiRetention()

	got := readJSON(t, filepath.Join(home, ".gemini", "settings.json"))
	general, ok := got["general"].(map[string]any)
	if !ok {
		t.Fatalf("missing general: %v", got)
	}
	sr, ok := general["sessionRetention"].(map[string]any)
	if !ok {
		t.Fatalf("missing general.sessionRetention: %v", general)
	}
	if sr["enabled"] != false {
		t.Fatalf("general.sessionRetention.enabled = %v, want false", sr["enabled"])
	}
}

func TestEnsureGeminiRetention_PreservesAuthBlock(t *testing.T) {
	home := withFakeHome(t)
	dir := filepath.Join(home, ".gemini")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	// Mirror what server.go writes earlier in startup.
	existing := map[string]any{
		"security": map[string]any{
			"auth": map[string]any{"selectedType": "gemini-api-key"},
		},
	}
	body, _ := json.MarshalIndent(existing, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), body, 0600); err != nil {
		t.Fatal(err)
	}

	ensureGeminiRetention()

	got := readJSON(t, filepath.Join(dir, "settings.json"))
	sec, ok := got["security"].(map[string]any)
	if !ok {
		t.Fatalf("security clobbered: %v", got)
	}
	auth, ok := sec["auth"].(map[string]any)
	if !ok || auth["selectedType"] != "gemini-api-key" {
		t.Fatalf("security.auth clobbered: %v", sec)
	}
	general, _ := got["general"].(map[string]any)
	sr, _ := general["sessionRetention"].(map[string]any)
	if sr["enabled"] != false {
		t.Fatalf("general.sessionRetention.enabled not set: %v", general)
	}
}

func TestEnsureQwenRetention_FreshFile(t *testing.T) {
	home := withFakeHome(t)
	ensureQwenRetention()

	got := readJSON(t, filepath.Join(home, ".qwen", "settings.json"))
	es, ok := got["episodicSummary"].(map[string]any)
	if !ok {
		t.Fatalf("missing episodicSummary: %v", got)
	}
	if es["autoCleanup"] != false {
		t.Fatalf("episodicSummary.autoCleanup = %v, want false", es["autoCleanup"])
	}
}

func TestEnsureRetentionConfigs_AllFiveAgents(t *testing.T) {
	home := withFakeHome(t)
	EnsureRetentionConfigs()

	// claude_code
	cc := readJSON(t, filepath.Join(home, ".claude", "settings.json"))
	if v, _ := cc["cleanupPeriodDays"].(float64); int(v) != claudeCodeCleanupForever {
		t.Errorf("claude cleanupPeriodDays = %v", cc["cleanupPeriodDays"])
	}
	// gemini
	g := readJSON(t, filepath.Join(home, ".gemini", "settings.json"))
	if sr, _ := g["general"].(map[string]any)["sessionRetention"].(map[string]any); sr["enabled"] != false {
		t.Errorf("gemini sessionRetention.enabled = %v", sr["enabled"])
	}
	// qwen
	q := readJSON(t, filepath.Join(home, ".qwen", "settings.json"))
	if es, _ := q["episodicSummary"].(map[string]any); es["autoCleanup"] != false {
		t.Errorf("qwen episodicSummary.autoCleanup = %v", es["autoCleanup"])
	}
	// codex / opencode are no-ops (no files written), nothing to verify.
}

func TestMergeNested_ReplacesNonObjectIntermediate(t *testing.T) {
	settings := map[string]any{"general": "not an object"}
	mergeNested(settings, []string{"general", "sessionRetention", "enabled"}, false)
	general, ok := settings["general"].(map[string]any)
	if !ok {
		t.Fatalf("general should have been replaced with map: %v", settings["general"])
	}
	sr, _ := general["sessionRetention"].(map[string]any)
	if sr["enabled"] != false {
		t.Fatalf("nested set failed: %v", general)
	}
}

func TestNumericGTE(t *testing.T) {
	cases := []struct {
		name      string
		v         any
		threshold int
		want      bool
		ok        bool
	}{
		{"float64-equal", float64(999999), 999999, true, true},
		{"float64-above", float64(1000000), 999999, true, true},
		{"float64-below", float64(30), 999999, false, true},
		{"int-equal", 999999, 999999, true, true},
		{"int-below", 30, 999999, false, true},
		{"string", "lots", 999999, false, false},
		{"nil", nil, 999999, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := numericGTE(tc.v, tc.threshold)
			if got != tc.want || ok != tc.ok {
				t.Errorf("numericGTE(%v,%d) = (%v,%v), want (%v,%v)", tc.v, tc.threshold, got, ok, tc.want, tc.ok)
			}
		})
	}
}
