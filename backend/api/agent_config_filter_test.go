package api

import (
	"encoding/json"
	"testing"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/server"
)

// modelCurrentValue runs a config_option_update frame through rewriteModelOptions
// and returns the resulting model option's currentValue.
func modelCurrentValue(t *testing.T, reported, selected string, models []server.AgentModelInfo) string {
	t.Helper()
	in, _ := json.Marshal(map[string]any{
		"sessionUpdate": "config_option_update",
		"configOptions": []map[string]any{
			{"id": "model", "category": "model", "currentValue": reported},
		},
	})
	out := rewriteModelOptions(in, models, selected)
	var frame struct {
		ConfigOptions []map[string]any `json:"configOptions"`
	}
	if err := json.Unmarshal(out, &frame); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	cv, _ := frame.ConfigOptions[0]["currentValue"].(string)
	return cv
}

// TestRewriteModelOptions_CurrentValue covers the "opus snaps to deepseek" bug:
// claude-agent-acp 0.55.0 reports a short display alias ("opus[1m]") instead of
// the full gateway id, so an exact match fails and the display must fall back to
// the model the session was actually spawned with — not gatewayModels[0].
func TestRewriteModelOptions_CurrentValue(t *testing.T) {
	models := []server.AgentModelInfo{
		{Value: "deepseek-v4-pro[1m]", Name: "DeepSeek"},
		{Value: "claude-opus-4-8[1m]", Name: "Opus"},
		{Value: "gpt-5.5", Name: "GPT"},
	}
	cases := []struct {
		name, reported, selected, want string
	}{
		{"alias reported, opus selected → opus", "opus[1m]", "claude-opus-4-8[1m]", "claude-opus-4-8[1m]"},
		{"exact gateway id preserved", "gpt-5.5", "claude-opus-4-8[1m]", "gpt-5.5"},
		{"unknown + no selected → gateway default", "default", "", "deepseek-v4-pro[1m]"},
		{"unknown + invalid selected → gateway default", "opus[1m]", "not-a-model", "deepseek-v4-pro[1m]"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := modelCurrentValue(t, tc.reported, tc.selected, models); got != tc.want {
				t.Fatalf("reported=%q selected=%q: got currentValue=%q, want %q", tc.reported, tc.selected, got, tc.want)
			}
		})
	}
}

func TestBroadcastConfigUpdate_UsesSetModelResponse(t *testing.T) {
	state := agentsdk.NewSessionState("session-1")
	models := []server.AgentModelInfo{
		{Value: "gpt-5.5", Name: "GPT-5.5"},
		{Value: "gpt-5.6-sol", Name: "GPT-5.6 Sol"},
	}
	updatedOpts := []map[string]any{
		{
			"id":           "model",
			"category":     "model",
			"currentValue": "gpt-5.6-sol",
		},
	}

	broadcastConfigUpdate(state, models, updatedOpts, "session-1", "gpt-5.6-sol")

	frames := state.GetRecentMessages(1)
	if len(frames) != 1 {
		t.Fatalf("expected one config update frame, got %d", len(frames))
	}

	var frame struct {
		SessionUpdate string `json:"sessionUpdate"`
		ConfigOptions []struct {
			ID           string `json:"id"`
			CurrentValue string `json:"currentValue"`
		} `json:"configOptions"`
	}
	if err := json.Unmarshal(frames[0], &frame); err != nil {
		t.Fatalf("unmarshal config update: %v", err)
	}
	if frame.SessionUpdate != "config_option_update" {
		t.Fatalf("unexpected sessionUpdate %q", frame.SessionUpdate)
	}
	if len(frame.ConfigOptions) != 1 || frame.ConfigOptions[0].ID != "model" {
		t.Fatalf("unexpected config options: %+v", frame.ConfigOptions)
	}
	if got := frame.ConfigOptions[0].CurrentValue; got != "gpt-5.6-sol" {
		t.Fatalf("model currentValue=%q, want gpt-5.6-sol", got)
	}
}

// TestFilterHiddenConfigOptions_StripsFast verifies the native Claude Code
// "Fast mode" option is removed from config_option_update frames while every
// other option is preserved in order.
func TestFilterHiddenConfigOptions_StripsFast(t *testing.T) {
	in := []byte(`{"sessionUpdate":"config_option_update","configOptions":[` +
		`{"id":"model","category":"model","currentValue":"opus"},` +
		`{"id":"effort","category":"thought_level","currentValue":"high"},` +
		`{"id":"fast","category":"model_config","currentValue":"off"}` +
		`]}`)

	out := filterHiddenConfigOptions(in)

	var frame struct {
		SessionUpdate string `json:"sessionUpdate"`
		ConfigOptions []struct {
			ID string `json:"id"`
		} `json:"configOptions"`
	}
	if err := json.Unmarshal(out, &frame); err != nil {
		t.Fatalf("unmarshal filtered frame: %v", err)
	}
	if frame.SessionUpdate != "config_option_update" {
		t.Fatalf("sessionUpdate changed: %q", frame.SessionUpdate)
	}
	if len(frame.ConfigOptions) != 2 {
		t.Fatalf("expected 2 options after filtering, got %d", len(frame.ConfigOptions))
	}
	for _, opt := range frame.ConfigOptions {
		if opt.ID == "fast" {
			t.Fatalf("fast option was not stripped")
		}
	}
	if frame.ConfigOptions[0].ID != "model" || frame.ConfigOptions[1].ID != "effort" {
		t.Fatalf("option order not preserved: %+v", frame.ConfigOptions)
	}
}

// TestFilterHiddenConfigOptions_PassThrough verifies non-config frames and
// frames without hidden options are returned unchanged (byte-identical).
func TestFilterHiddenConfigOptions_PassThrough(t *testing.T) {
	other := []byte(`{"sessionUpdate":"agent_message_chunk","content":{"text":"hi"}}`)
	if got := filterHiddenConfigOptions(other); string(got) != string(other) {
		t.Fatalf("non-config frame mutated: %s", got)
	}

	noFast := []byte(`{"sessionUpdate":"config_option_update","configOptions":[{"id":"model","category":"model","currentValue":"opus"}]}`)
	if got := filterHiddenConfigOptions(noFast); string(got) != string(noFast) {
		t.Fatalf("frame without fast mutated: %s", got)
	}
}

// TestClaudeCodeEffortMatchesAgentNative locks in the effort levels
// claude-agent-acp actually reports. The static list used to omit "default" and
// "xhigh" — both routine persisted values — which was masked only because a
// stale config_option_update was replayed from disk. With that frame gone, a
// missing level means the picker silently renders the first choice instead of
// the session's real one.
func TestClaudeCodeEffortMatchesAgentNative(t *testing.T) {
	opts := buildAgentConfigOptions("claude_code", nil)
	var effort *configOption
	for i := range opts {
		if opts[i].ID == "effort" {
			effort = &opts[i]
			break
		}
	}
	if effort == nil {
		t.Fatal("claude_code has no effort option")
	}
	got := make(map[string]bool, len(effort.Options))
	for _, c := range effort.Options {
		got[c.Value] = true
	}
	for _, want := range []string{"default", "low", "medium", "high", "xhigh", "max"} {
		if !got[want] {
			t.Errorf("effort level %q missing from options", want)
		}
	}
}

// TestResolveSessionModel covers resuming a session after AGENT_MODELS changed.
func TestResolveSessionModel(t *testing.T) {
	models := []server.AgentModelInfo{
		{Value: "claude-opus-5", Name: "Opus 5"},
		{Value: "gpt-5.6-sol", Name: "GPT"},
	}
	cases := []struct {
		name, persisted string
		models          []server.AgentModelInfo
		want            string
		wantFellBack    bool
	}{
		{"no gateway list → passthrough", "opus[1m]", nil, "opus[1m]", false},
		{"no gateway list, nothing persisted", "", nil, "", false},
		{"nothing persisted → gateway default", "", models, "claude-opus-5", false},
		{"still available → unchanged", "gpt-5.6-sol", models, "gpt-5.6-sol", false},
		{"removed model → gateway default", "claude-opus-4-8", models, "claude-opus-5", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, fellBack := resolveSessionModel(tc.persisted, tc.models)
			if got != tc.want || fellBack != tc.wantFellBack {
				t.Fatalf("resolveSessionModel(%q) = (%q, %v), want (%q, %v)",
					tc.persisted, got, fellBack, tc.want, tc.wantFellBack)
			}
		})
	}
}

// TestOverlayPersistedConfigOptions_RejectsNonMemberValue verifies the
// invariant that currentValue is always a member of options. A saved value that
// no longer exists must fall through to the default rather than becoming a
// phantom the frontend selector silently misrenders.
func TestOverlayPersistedConfigOptions_RejectsNonMemberValue(t *testing.T) {
	models := []server.AgentModelInfo{
		{Value: "claude-opus-5", Name: "Opus 5"},
		{Value: "gpt-5.6-sol", Name: "GPT"},
	}
	currentValues := func(opts []configOption) map[string]string {
		out := make(map[string]string, len(opts))
		for _, o := range opts {
			out[o.ID] = o.CurrentValue
		}
		return out
	}

	t.Run("removed model falls back to gateway default", func(t *testing.T) {
		opts := buildAgentConfigOptions("claude_code", models)
		got := currentValues(overlayPersistedConfigOptions(opts,
			map[string]string{"model": "claude-opus-4-8"}, ""))
		if got["model"] != "claude-opus-5" {
			t.Fatalf("model currentValue = %q, want gateway default", got["model"])
		}
	})

	t.Run("available model is honoured", func(t *testing.T) {
		opts := buildAgentConfigOptions("claude_code", models)
		got := currentValues(overlayPersistedConfigOptions(opts,
			map[string]string{"model": "gpt-5.6-sol"}, ""))
		if got["model"] != "gpt-5.6-sol" {
			t.Fatalf("model currentValue = %q, want gpt-5.6-sol", got["model"])
		}
	})

	t.Run("xhigh effort is honoured", func(t *testing.T) {
		opts := buildAgentConfigOptions("claude_code", models)
		got := currentValues(overlayPersistedConfigOptions(opts,
			map[string]string{"effort": "xhigh"}, ""))
		if got["effort"] != "xhigh" {
			t.Fatalf("effort currentValue = %q, want xhigh", got["effort"])
		}
	})

	t.Run("bogus effort falls back to static default", func(t *testing.T) {
		opts := buildAgentConfigOptions("claude_code", models)
		got := currentValues(overlayPersistedConfigOptions(opts,
			map[string]string{"effort": "ludicrous"}, ""))
		if got["effort"] != "high" {
			t.Fatalf("effort currentValue = %q, want static default high", got["effort"])
		}
	})

	t.Run("mode comes from its own column", func(t *testing.T) {
		opts := buildAgentConfigOptions("claude_code", models)
		got := currentValues(overlayPersistedConfigOptions(opts, nil, "plan"))
		if got["mode"] != "plan" {
			t.Fatalf("mode currentValue = %q, want plan", got["mode"])
		}
	})

	t.Run("bogus mode falls back to static default", func(t *testing.T) {
		opts := buildAgentConfigOptions("claude_code", models)
		got := currentValues(overlayPersistedConfigOptions(opts, nil, "notAMode"))
		if got["mode"] != "bypassPermissions" {
			t.Fatalf("mode currentValue = %q, want bypassPermissions", got["mode"])
		}
	})
}
