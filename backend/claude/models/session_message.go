package models

import "strings"

// filterSystemTags removes system-injected XML tags from text.
// Returns empty string if text is only system tags.
// Used by UserSessionMessage.GetUserPrompt() to extract actual user input.
func filterSystemTags(text string) string {
	// Check if text starts with a system tag
	if strings.HasPrefix(text, "<ide_") ||
		strings.HasPrefix(text, "<system-reminder>") {
		return ""
	}
	return strings.TrimSpace(text)
}
