package api

import (
	"strings"

	"golang.org/x/text/language"
)

// ResolveUILocale picks the UI locale in priority order:
//  1. userPref if it's non-empty and in supported
//  2. best match from Accept-Language header among supported
//  3. fallback
//
// supported is the list of BCP 47 tags the frontend actually has catalogs for.
func ResolveUILocale(userPref, acceptLang string, supported []string, fallback string) string {
	if userPref != "" {
		for _, s := range supported {
			if strings.EqualFold(userPref, s) {
				return s
			}
		}
	}

	if acceptLang != "" {
		supportedTags := make([]language.Tag, 0, len(supported))
		for _, s := range supported {
			supportedTags = append(supportedTags, language.Make(s))
		}
		matcher := language.NewMatcher(supportedTags)

		userTags, _, err := language.ParseAcceptLanguage(acceptLang)
		if err == nil && len(userTags) > 0 {
			_, idx, confidence := matcher.Match(userTags...)
			if confidence >= language.High {
				return supported[idx]
			}
		}
	}

	return fallback
}
