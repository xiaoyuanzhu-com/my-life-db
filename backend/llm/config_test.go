package llm

import "testing"

func TestNewConfig_FromEnv(t *testing.T) {
	t.Setenv("MLD_LLM_ANTHROPIC_KEY", "sk-ant-test")
	t.Setenv("MLD_LLM_ANTHROPIC_URL", "https://custom.anthropic.com")
	t.Setenv("MLD_LLM_OPENAI_KEY", "sk-openai-test")
	t.Setenv("MLD_LLM_OPENAI_URL", "https://custom.openai.com")

	cfg := NewConfigFromEnv()

	if cfg.Anthropic.APIKey != "sk-ant-test" {
		t.Errorf("Anthropic.APIKey = %q, want %q", cfg.Anthropic.APIKey, "sk-ant-test")
	}
	if cfg.Anthropic.BaseURL != "https://custom.anthropic.com" {
		t.Errorf("Anthropic.BaseURL = %q, want custom URL", cfg.Anthropic.BaseURL)
	}
	if cfg.OpenAI.APIKey != "sk-openai-test" {
		t.Errorf("OpenAI.APIKey = %q, want %q", cfg.OpenAI.APIKey, "sk-openai-test")
	}
	if cfg.OpenAI.BaseURL != "https://custom.openai.com" {
		t.Errorf("OpenAI.BaseURL = %q, want custom URL", cfg.OpenAI.BaseURL)
	}
	if !cfg.HasAnthropic() {
		t.Error("HasAnthropic() = false, want true")
	}
	if !cfg.HasOpenAI() {
		t.Error("HasOpenAI() = false, want true")
	}
}

func TestNewConfig_Defaults(t *testing.T) {
	cfg := NewConfigFromEnv()

	if cfg.HasAnthropic() {
		t.Error("HasAnthropic() = true with no env, want false")
	}
	if cfg.HasOpenAI() {
		t.Error("HasOpenAI() = true with no env, want false")
	}
	if cfg.Anthropic.BaseURL != "https://api.anthropic.com" {
		t.Errorf("Anthropic.BaseURL default = %q, want https://api.anthropic.com", cfg.Anthropic.BaseURL)
	}
	if cfg.OpenAI.BaseURL != "https://api.openai.com" {
		t.Errorf("OpenAI.BaseURL default = %q, want https://api.openai.com", cfg.OpenAI.BaseURL)
	}
}

func TestNewConfig_ProxyTokenGenerated(t *testing.T) {
	cfg := NewConfigFromEnv()

	if cfg.ProxyToken == "" {
		t.Error("ProxyToken is empty")
	}
	if len(cfg.ProxyToken) < 32 {
		t.Errorf("ProxyToken length = %d, want >= 32", len(cfg.ProxyToken))
	}

	// Each call generates a unique token
	cfg2 := NewConfigFromEnv()
	if cfg.ProxyToken == cfg2.ProxyToken {
		t.Error("two calls generated the same ProxyToken")
	}
}
