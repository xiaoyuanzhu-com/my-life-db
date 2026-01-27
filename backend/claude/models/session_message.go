package models

import (
	"regexp"
	"strings"
)

// ============================================================================
// System Tag Filtering for First User Prompt Extraction
// ============================================================================
//
// This module filters out system-injected XML tags from user messages to extract
// the actual user-typed content. This is used for deriving session titles from
// the first meaningful user prompt.
//
// FILTERING LOGIC (must match frontend's isSkippedXmlContent in session-message-utils.ts):
//
// There are two types of filters:
//
// 1. PREFIX-BASED FILTERS (always filtered if content starts with these):
//    - <ide_*>         - IDE-injected context (VS Code, JetBrains, etc.)
//    - <system-reminder> - System reminders injected by Claude Code
//    These are ALWAYS system content when they appear at the start.
//
// 2. TAG-BASED FILTERS (only filtered if content is ENTIRELY these tags):
//    - <command-name>         - Local slash command name (e.g., /clear)
//    - <command-message>      - Local command message text
//    - <command-args>         - Local command arguments
//    - <local-command-caveat> - Caveat about local commands
//    - <local-command-stdout> - Stdout from local command execution
//
//    For tag-based filters, we check:
//    a) Content contains at least one XML tag
//    b) ALL XML tags in content are in the skip list
//    c) No other content outside tags (only whitespace allowed)
//
//    This prevents accidentally filtering real user messages that might
//    contain these tags as part of legitimate content.
//
// EXAMPLES:
//   "<command-name>/clear</command-name>"                    → filtered (only skipped tags)
//   "<command-name>/clear</command-name>\n<command-args>"    → filtered (only skipped tags)
//   "Hello <command-name>/clear</command-name>"              → NOT filtered (has "Hello")
//   "<unknown-tag>foo</unknown-tag>"                         → NOT filtered (unknown tag)
//   "pls debug below logs"                                   → NOT filtered (no tags)
//   "<ide_selection>code</ide_selection>"                    → filtered (prefix match)
//
// ============================================================================

// skippedXMLTags defines XML tags that indicate system-injected content.
// If a user message consists ENTIRELY of these tags (no other content), skip it.
// See docs/claude-code/ui.md Section 6.3 "Skipped Message Types".
var skippedXMLTags = map[string]bool{
	"command-name":         true,
	"command-message":      true,
	"command-args":         true,
	"local-command-caveat": true,
	"local-command-stdout": true,
}

// openingTagPattern matches opening XML tags and captures the tag name.
// Examples: <command-name>, <local-command-caveat attr="value">
var openingTagPattern = regexp.MustCompile(`<([a-zA-Z][a-zA-Z0-9_-]*)[^>]*>`)

// filterSystemTags filters system-injected XML tags from text.
// Returns empty string if text consists ONLY of system tags.
// Returns trimmed text otherwise.
//
// Used by UserSessionMessage.GetUserPrompt() to extract actual user input
// for session title derivation.
func filterSystemTags(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}

	// PREFIX-BASED FILTERS: Always filter if content starts with these
	// These are always system content, never user-typed
	if strings.HasPrefix(trimmed, "<ide_") ||
		strings.HasPrefix(trimmed, "<system-reminder>") {
		return ""
	}

	// Fast path: if doesn't start with '<', it can't be all XML tags
	if !strings.HasPrefix(trimmed, "<") {
		return trimmed
	}

	// TAG-BASED FILTERS: Only filter if content is ENTIRELY skipped tags
	// Extract all opening tag names
	matches := openingTagPattern.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return trimmed
	}

	// Check if ALL tags are in the skip list
	allTagsSkipped := true
	for _, match := range matches {
		tagName := match[1]
		if !skippedXMLTags[tagName] {
			allTagsSkipped = false
			break
		}
	}

	if !allTagsSkipped {
		// Contains non-skipped tags, keep the content
		return trimmed
	}

	// All tags are skipped tags. Now check if there's other content.
	// Remove all XML tags (opening, closing, and self-closing) and their content
	contentWithoutTags := text

	// Remove complete tag pairs: <tag>...</tag>
	for tagName := range skippedXMLTags {
		// Pattern: <tagname>anything</tagname> (non-greedy)
		// We build this dynamically since Go doesn't support backreferences
		pattern := regexp.MustCompile(`<` + regexp.QuoteMeta(tagName) + `[^>]*>[\s\S]*?</` + regexp.QuoteMeta(tagName) + `>`)
		contentWithoutTags = pattern.ReplaceAllString(contentWithoutTags, "")
	}

	// Also remove any remaining self-closing tags: <tagname/>
	selfClosingPattern := regexp.MustCompile(`<([a-zA-Z][a-zA-Z0-9_-]*)[^>]*/>`)
	contentWithoutTags = selfClosingPattern.ReplaceAllString(contentWithoutTags, "")

	// If only whitespace remains, content was ONLY skipped XML tags
	if strings.TrimSpace(contentWithoutTags) == "" {
		return ""
	}

	return trimmed
}
