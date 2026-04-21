package api

import "testing"

func TestResolveUILocale(t *testing.T) {
	supported := []string{"en", "zh-Hans"}
	cases := []struct {
		name       string
		pref       string
		acceptLang string
		want       string
	}{
		{"pref_exact_match", "zh-Hans", "en", "zh-Hans"},
		{"pref_unsupported_falls_back_to_accept", "fr", "zh-Hans,en;q=0.5", "zh-Hans"},
		{"no_pref_accept_en", "", "en-US,en;q=0.9", "en"},
		{"no_pref_accept_zh_hans", "", "zh-CN,zh;q=0.9", "zh-Hans"},
		{"no_pref_accept_unsupported", "", "fr-FR,fr;q=0.9", "en"},
		{"no_pref_no_accept", "", "", "en"},
		{"zh_tw_falls_back_to_en", "", "zh-TW", "en"}, // Phase 1: zh-Hant not supported
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveUILocale(tc.pref, tc.acceptLang, supported, "en")
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
