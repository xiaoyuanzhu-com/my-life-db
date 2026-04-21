package api

import (
	"strings"
	"testing"
)

func TestBuildSPAContext(t *testing.T) {
	cases := []struct {
		name            string
		userPref        string
		acceptLang      string
		wantLang        string
		wantPreloadHint string // substring expected in PreloadCatalogs, or "" for none
	}{
		{
			name:            "pref_zh_hans",
			userPref:        "zh-Hans",
			acceptLang:      "en",
			wantLang:        "zh-Hans",
			wantPreloadHint: "/locales/zh-Hans/common.json",
		},
		{
			name:            "unset_pref_accept_zh",
			userPref:        "",
			acceptLang:      "zh-CN,zh;q=0.9",
			wantLang:        "zh-Hans",
			wantPreloadHint: "/locales/zh-Hans/common.json",
		},
		{
			name:            "unset_pref_no_accept",
			userPref:        "",
			acceptLang:      "",
			wantLang:        "en",
			wantPreloadHint: "", // English: no preload link
		},
		{
			name:            "unsupported_pref_no_accept",
			userPref:        "fr",
			acceptLang:      "",
			wantLang:        "en",
			wantPreloadHint: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildSPAContext(tc.userPref, tc.acceptLang)
			if got.Lang != tc.wantLang {
				t.Errorf("Lang = %q, want %q", got.Lang, tc.wantLang)
			}
			if tc.wantPreloadHint == "" {
				if len(got.PreloadCatalogs) != 0 {
					t.Errorf("PreloadCatalogs = %v, want empty", got.PreloadCatalogs)
				}
			} else {
				found := false
				for _, p := range got.PreloadCatalogs {
					if strings.Contains(p, tc.wantPreloadHint) {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("PreloadCatalogs %v does not contain %q", got.PreloadCatalogs, tc.wantPreloadHint)
				}
			}
		})
	}
}
