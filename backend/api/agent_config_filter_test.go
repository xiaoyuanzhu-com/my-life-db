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
