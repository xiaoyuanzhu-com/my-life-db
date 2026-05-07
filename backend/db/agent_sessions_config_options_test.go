package db

import (
	"context"
	"path/filepath"
	"testing"
)

func openTestAppDB(t *testing.T) *DB {
	t.Helper()
	cfg := Config{
		Path:         filepath.Join(t.TempDir(), "app.sqlite"),
		Role:         DBRoleApp,
		MaxOpenConns: 4,
		MaxIdleConns: 2,
	}
	d, err := Open(cfg)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	d.StartWriter(WriterConfig{})
	return d
}

func TestAgentSessionConfigOptions_Empty(t *testing.T) {
	d := openTestAppDB(t)
	ctx := context.Background()
	if err := d.CreateAgentSession(ctx, "s1", "claude_code", "/tmp", "", "user", "", "", "", "stor1"); err != nil {
		t.Fatalf("CreateAgentSession: %v", err)
	}
	got, err := d.GetAgentSessionConfigOptions("s1")
	if err != nil {
		t.Fatalf("GetAgentSessionConfigOptions: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty map, got %v", got)
	}
}

func TestAgentSessionConfigOptions_SaveAndGet(t *testing.T) {
	d := openTestAppDB(t)
	ctx := context.Background()
	if err := d.CreateAgentSession(ctx, "s1", "claude_code", "/tmp", "", "user", "", "", "", "stor1"); err != nil {
		t.Fatalf("CreateAgentSession: %v", err)
	}
	if err := d.SaveAgentSessionConfigOption(ctx, "s1", "model", "gpt-5.4"); err != nil {
		t.Fatalf("SaveAgentSessionConfigOption: %v", err)
	}
	got, err := d.GetAgentSessionConfigOptions("s1")
	if err != nil {
		t.Fatalf("GetAgentSessionConfigOptions: %v", err)
	}
	if got["model"] != "gpt-5.4" {
		t.Fatalf("expected model=gpt-5.4, got %v", got)
	}
}

func TestAgentSessionConfigOptions_MergePreservesOtherKeys(t *testing.T) {
	d := openTestAppDB(t)
	ctx := context.Background()
	if err := d.CreateAgentSession(ctx, "s1", "codex", "/tmp", "", "user", "", "", "", "stor1"); err != nil {
		t.Fatalf("CreateAgentSession: %v", err)
	}
	if err := d.SaveAgentSessionConfigOption(ctx, "s1", "model", "gpt-5.4"); err != nil {
		t.Fatalf("save model: %v", err)
	}
	if err := d.SaveAgentSessionConfigOption(ctx, "s1", "reasoning_effort", "high"); err != nil {
		t.Fatalf("save effort: %v", err)
	}
	if err := d.SaveAgentSessionConfigOption(ctx, "s1", "model", "gpt-5.2"); err != nil {
		t.Fatalf("update model: %v", err)
	}
	got, err := d.GetAgentSessionConfigOptions("s1")
	if err != nil {
		t.Fatalf("GetAgentSessionConfigOptions: %v", err)
	}
	if got["model"] != "gpt-5.2" {
		t.Fatalf("model not updated: %v", got)
	}
	if got["reasoning_effort"] != "high" {
		t.Fatalf("reasoning_effort lost on second save: %v", got)
	}
}
