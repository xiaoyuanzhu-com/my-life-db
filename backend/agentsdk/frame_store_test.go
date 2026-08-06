package agentsdk

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// chunkFrame builds an agent_message_chunk carrying the given text.
func chunkFrame(text string) string {
	return `{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":` +
		`"` + text + `"}}`
}

const configFrame = `{"sessionUpdate":"config_option_update","configOptions":` +
	`[{"id":"model","category":"model","currentValue":"claude-opus-4-8",` +
	`"options":[{"value":"claude-opus-4-8","name":"Claude Opus 4.8"}]}]}`

// writeJSONL seeds a session file directly, simulating frames written before
// Append learned to reject ephemeral ones.
func writeJSONL(t *testing.T, dir, sessionID string, lines ...string) {
	t.Helper()
	framesDir := filepath.Join(dir, "agent_frames")
	if err := os.MkdirAll(framesDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(framesDir, sessionID+".jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// TestFrameStore_AppendDropsConfigOptionUpdate covers the primary fix: a
// config_option_update snapshots the model list at the moment it was sent, so
// persisting it makes a historical session replay models that may no longer
// exist. It must never reach disk.
func TestFrameStore_AppendDropsConfigOptionUpdate(t *testing.T) {
	dir := t.TempDir()
	fs := NewFrameStore(dir)

	fs.Append("s1", []byte(configFrame))
	fs.Append("s1", []byte(chunkFrame("hello")))
	fs.Close() // drains writers

	frames, err := fs.Load("s1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(frames) != 1 {
		t.Fatalf("got %d frames, want 1: %q", len(frames), frames)
	}
	if !strings.Contains(string(frames[0]), "hello") {
		t.Fatalf("wrong frame survived: %s", frames[0])
	}
}

// TestFrameStore_LoadSkipsLegacyConfigOptionUpdate is the self-heal path:
// files written before the Append filter existed still contain stale frames,
// and filtering on read fixes those sessions without a migration.
func TestFrameStore_LoadSkipsLegacyConfigOptionUpdate(t *testing.T) {
	dir := t.TempDir()
	writeJSONL(t, dir, "s2", chunkFrame("before"), configFrame, chunkFrame("after"))

	frames, err := NewFrameStore(dir).Load("s2")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(frames) != 2 {
		t.Fatalf("got %d frames, want 2", len(frames))
	}
	for _, f := range frames {
		if strings.Contains(string(f), `"sessionUpdate":"config_option_update"`) {
			t.Fatalf("stale config frame survived load: %s", f)
		}
	}
	if !strings.Contains(string(frames[0]), "before") || !strings.Contains(string(frames[1]), "after") {
		t.Fatalf("order not preserved: %q", frames)
	}
}

// TestFrameStore_KeepsFrameMentioningConfigOptionUpdate guards the substring
// fast path. In the live frame store 142 of 3165 lines containing
// "config_option_update" are ordinary messages that merely quote it — a session
// discussing this very code produces them. Matching on the substring alone
// would delete real conversation, so the marker must be confirmed against the
// sessionUpdate field.
func TestFrameStore_KeepsFrameMentioningConfigOptionUpdate(t *testing.T) {
	quoting := chunkFrame("the config_option_update frame is persisted")

	t.Run("survives Append", func(t *testing.T) {
		dir := t.TempDir()
		fs := NewFrameStore(dir)
		fs.Append("s3", []byte(quoting))
		fs.Close()

		frames, err := fs.Load("s3")
		if err != nil {
			t.Fatalf("load: %v", err)
		}
		if len(frames) != 1 {
			t.Fatalf("got %d frames, want 1 — a real message was eaten", len(frames))
		}
	})

	t.Run("survives Load", func(t *testing.T) {
		dir := t.TempDir()
		writeJSONL(t, dir, "s4", quoting)

		frames, err := NewFrameStore(dir).Load("s4")
		if err != nil {
			t.Fatalf("load: %v", err)
		}
		if len(frames) != 1 {
			t.Fatalf("got %d frames, want 1 — a real message was eaten", len(frames))
		}
	})
}

// TestFrameStore_LoadSkipsInvalidJSON is a regression guard that the
// pre-existing partial-line handling still works alongside the new filter.
func TestFrameStore_LoadSkipsInvalidJSON(t *testing.T) {
	dir := t.TempDir()
	writeJSONL(t, dir, "s5", chunkFrame("good"), `{"sessionUpdate":"agent_mess`)

	frames, err := NewFrameStore(dir).Load("s5")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(frames) != 1 {
		t.Fatalf("got %d frames, want 1", len(frames))
	}
}

func TestFrameStore_LoadStripsLegacyCodexExecOutput(t *testing.T) {
	dir := t.TempDir()
	writeJSONL(t, dir, "s6", `{"content":[{"content":{"text":"large","type":"text"},"type":"content"}],"rawOutput":{"aggregated_output":"large","call_id":"call_1","cwd":"/workspace","formatted_output":"large","source":"unified_exec_startup","stderr":"","stdout":"large"},"sessionUpdate":"tool_call_update","status":"completed","toolCallId":"call_1"}`)

	frames, err := NewFrameStore(dir).Load("s6")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(frames) != 1 {
		t.Fatalf("got %d frames, want 1", len(frames))
	}

	frame := string(frames[0])
	for _, field := range []string{"aggregated_output", "formatted_output", "stdout"} {
		if strings.Contains(frame, `"`+field+`"`) {
			t.Errorf("legacy Codex frame still contains %s: %s", field, frame)
		}
	}
	if strings.Contains(frame, `"content"`) {
		t.Fatalf("legacy Codex frame still contains top-level content: %s", frame)
	}
	if !strings.Contains(frame, `"cwd":"/workspace"`) {
		t.Fatalf("legacy Codex frame lost preserved metadata: %s", frame)
	}
}
