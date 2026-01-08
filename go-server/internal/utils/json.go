package utils

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

// ParseJSONFromLLMResponse robustly parses JSON from LLM responses.
// Handles various formats:
// - Raw JSON: {"tags": [...]}
// - Code blocks: ```json\n{...}\n``` or ```\n{...}\n```
// - Surrounding text: "Here are the tags: {...}"
// - Arrays: [...]
func ParseJSONFromLLMResponse(content string) (interface{}, error) {
	content = strings.TrimSpace(content)

	// Try direct parse first
	var result interface{}
	if err := json.Unmarshal([]byte(content), &result); err == nil {
		return result, nil
	}

	// Try to find JSON in markdown code blocks (```json or ```)
	codeBlockRe := regexp.MustCompile("```(?:json)?\\s*\\n?([\\s\\S]*?)\\n?```")
	if matches := codeBlockRe.FindStringSubmatch(content); len(matches) > 1 {
		if err := json.Unmarshal([]byte(strings.TrimSpace(matches[1])), &result); err == nil {
			return result, nil
		}
	}

	// Try to find JSON object by looking for outermost { ... }
	jsonObjectRe := regexp.MustCompile(`\{[\s\S]*\}`)
	if match := jsonObjectRe.FindString(content); match != "" {
		if err := json.Unmarshal([]byte(match), &result); err == nil {
			return result, nil
		}
	}

	// Try to find JSON array by looking for outermost [ ... ]
	jsonArrayRe := regexp.MustCompile(`\[[\s\S]*\]`)
	if match := jsonArrayRe.FindString(content); match != "" {
		if err := json.Unmarshal([]byte(match), &result); err == nil {
			return result, nil
		}
	}

	return nil, errors.New("unable to parse JSON from LLM response")
}

// ExtractTagsFromJSON extracts tags array from parsed JSON response
func ExtractTagsFromJSON(parsed interface{}, maxTags int) []string {
	var tags []string

	switch v := parsed.(type) {
	case map[string]interface{}:
		// Handle {"tags": [...]}
		if tagsVal, ok := v["tags"]; ok {
			if tagsArr, ok := tagsVal.([]interface{}); ok {
				for _, tag := range tagsArr {
					if s, ok := tag.(string); ok {
						s = strings.TrimSpace(s)
						if s != "" {
							tags = append(tags, s)
						}
					}
				}
			}
		}
	case []interface{}:
		// Handle direct array [...]
		for _, tag := range v {
			if s, ok := tag.(string); ok {
				s = strings.TrimSpace(s)
				if s != "" {
					tags = append(tags, s)
				}
			}
		}
	}

	// Limit to maxTags
	if maxTags > 0 && len(tags) > maxTags {
		tags = tags[:maxTags]
	}

	return tags
}
