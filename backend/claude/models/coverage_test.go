package models_test

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// TypeStats tracks statistics for a message type
type TypeStats struct {
	Type           string
	Subtype        string // For system/progress messages
	Status         string // "supported", "unknown"
	Count          int
	ExampleSession string
	ExampleLine    int
	ExampleJSON    string         // Sample JSON for new types
	ExtraFields    map[string]int // Fields in JSON not in our struct
}

// TestMessageTypeCoverage scans all Claude sessions and reports on message type coverage
func TestMessageTypeCoverage(t *testing.T) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("failed to get home directory: %v", err)
	}

	projectsDir := filepath.Join(homeDir, ".claude", "projects")

	// Check if directory exists
	if _, err := os.Stat(projectsDir); os.IsNotExist(err) {
		t.Skip("~/.claude/projects does not exist, skipping coverage test")
	}

	// Track stats by type key (type or type:subtype)
	stats := make(map[string]*TypeStats)
	totalMessages := 0
	totalSessions := 0
	parseErrors := 0

	// Known types from our models
	knownTypes := map[string]bool{
		"user":                  true,
		"assistant":             true,
		"system":                true,
		"system:init":           true,
		"system:compact_boundary": true,
		"system:turn_duration":  true,
		"result":                true,
		"progress":              true,
		"progress:hook_progress": true,
		"progress:bash_progress": true,
		"summary":               true,
		"custom-title":          true,
		"tag":                   true,
		"agent-name":            true,
		"queue-operation":       true,
		"file-history-snapshot": true,
	}

	// Walk through all .jsonl files
	err = filepath.Walk(projectsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // Skip files we can't access
		}

		if info.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}

		// Extract session ID from filename
		sessionID := strings.TrimSuffix(filepath.Base(path), ".jsonl")
		totalSessions++

		file, err := os.Open(path)
		if err != nil {
			return nil
		}
		defer file.Close()

		scanner := bufio.NewScanner(file)
		// Increase buffer size for large lines
		buf := make([]byte, 0, 1024*1024)
		scanner.Buffer(buf, 10*1024*1024)

		lineNum := 0
		for scanner.Scan() {
			lineNum++
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}

			totalMessages++

			// Parse to get type and subtype
			var base struct {
				Type    string          `json:"type"`
				Subtype string          `json:"subtype,omitempty"`
				Data    json.RawMessage `json:"data,omitempty"`
			}

			if err := json.Unmarshal([]byte(line), &base); err != nil {
				parseErrors++
				continue
			}

			// Determine the type key
			typeKey := base.Type
			subtype := base.Subtype

			// For progress messages, check data.type
			if base.Type == "progress" && len(base.Data) > 0 {
				var dataType struct {
					Type string `json:"type"`
				}
				if err := json.Unmarshal(base.Data, &dataType); err == nil && dataType.Type != "" {
					subtype = dataType.Type
				}
			}

			if subtype != "" {
				typeKey = base.Type + ":" + subtype
			}

			// Update stats
			if stats[typeKey] == nil {
				status := "unknown"
				if knownTypes[typeKey] || knownTypes[base.Type] {
					status = "supported"
				}
				// Store example JSON for types with subtypes (new subtypes to document)
				exampleJSON := ""
				if subtype != "" && !knownTypes[typeKey] {
					// Truncate for readability
					if len(line) > 500 {
						exampleJSON = line[:500] + "..."
					} else {
						exampleJSON = line
					}
				}
				stats[typeKey] = &TypeStats{
					Type:           base.Type,
					Subtype:        subtype,
					Status:         status,
					ExampleSession: sessionID,
					ExampleLine:    lineNum,
					ExampleJSON:    exampleJSON,
					ExtraFields:    make(map[string]int),
				}
			}
			stats[typeKey].Count++

			// Track extra fields (parse as map and compare)
			var rawMap map[string]interface{}
			if err := json.Unmarshal([]byte(line), &rawMap); err == nil {
				checkExtraFields(rawMap, base.Type, stats[typeKey].ExtraFields)
			}
		}

		return nil
	})

	if err != nil {
		t.Fatalf("failed to walk projects directory: %v", err)
	}

	// Generate report
	fmt.Println("\n" + strings.Repeat("=", 100))
	fmt.Println("CLAUDE SESSION MESSAGE TYPE COVERAGE REPORT")
	fmt.Println(strings.Repeat("=", 100))
	fmt.Printf("\nTotal sessions scanned: %d\n", totalSessions)
	fmt.Printf("Total messages parsed:  %d\n", totalMessages)
	fmt.Printf("Parse errors:           %d\n", parseErrors)
	fmt.Println()

	// Sort by count descending
	var sortedKeys []string
	for k := range stats {
		sortedKeys = append(sortedKeys, k)
	}
	sort.Slice(sortedKeys, func(i, j int) bool {
		return stats[sortedKeys[i]].Count > stats[sortedKeys[j]].Count
	})

	// Print table header
	fmt.Printf("%-35s %-12s %10s   %-40s\n", "TYPE", "STATUS", "COUNT", "EXAMPLE SESSION")
	fmt.Println(strings.Repeat("-", 100))

	supportedCount := 0
	unknownCount := 0
	supportedMessages := 0
	unknownMessages := 0

	for _, key := range sortedKeys {
		s := stats[key]
		typeDisplay := s.Type
		if s.Subtype != "" {
			typeDisplay = fmt.Sprintf("%s:%s", s.Type, s.Subtype)
		}

		fmt.Printf("%-35s %-12s %10d   %s:%d\n",
			typeDisplay,
			s.Status,
			s.Count,
			truncate(s.ExampleSession, 30),
			s.ExampleLine,
		)

		if s.Status == "supported" {
			supportedCount++
			supportedMessages += s.Count
		} else {
			unknownCount++
			unknownMessages += s.Count
		}
	}

	fmt.Println(strings.Repeat("-", 100))
	fmt.Printf("\nSummary:\n")
	fmt.Printf("  Supported types:  %d (%.1f%% of message types)\n", supportedCount, percent(supportedCount, supportedCount+unknownCount))
	fmt.Printf("  Unknown types:    %d (%.1f%% of message types)\n", unknownCount, percent(unknownCount, supportedCount+unknownCount))
	fmt.Printf("  Supported msgs:   %d (%.2f%% of messages)\n", supportedMessages, percent(supportedMessages, totalMessages))
	fmt.Printf("  Unknown msgs:     %d (%.2f%% of messages)\n", unknownMessages, percent(unknownMessages, totalMessages))

	// Print unknown types that need attention
	if unknownCount > 0 {
		fmt.Println("\n" + strings.Repeat("=", 100))
		fmt.Println("UNKNOWN TYPES (need struct definitions)")
		fmt.Println(strings.Repeat("=", 100))
		for _, key := range sortedKeys {
			s := stats[key]
			if s.Status == "unknown" {
				fmt.Printf("\nType: %s (count: %d)\n", key, s.Count)
				fmt.Printf("Example: %s:%d\n", s.ExampleSession, s.ExampleLine)
			}
		}
	}

	// Print new subtypes (types we parse but haven't explicitly listed)
	fmt.Println("\n" + strings.Repeat("=", 100))
	fmt.Println("NEW SUBTYPES (parsed but not in knownTypes - consider adding to documentation)")
	fmt.Println(strings.Repeat("=", 100))
	hasNewSubtypes := false
	for _, key := range sortedKeys {
		s := stats[key]
		if s.Subtype != "" && !knownTypes[key] && knownTypes[s.Type] {
			hasNewSubtypes = true
			fmt.Printf("\n%s (count: %d)\n", key, s.Count)
			fmt.Printf("Example: %s:%d\n", s.ExampleSession, s.ExampleLine)
			if s.ExampleJSON != "" {
				// Pretty print the JSON
				var prettyJSON map[string]interface{}
				if err := json.Unmarshal([]byte(s.ExampleJSON), &prettyJSON); err == nil {
					pretty, _ := json.MarshalIndent(prettyJSON, "  ", "  ")
					fmt.Printf("  Sample:\n  %s\n", string(pretty))
				}
			}
		}
	}
	if !hasNewSubtypes {
		fmt.Println("\n  (none)")
	}

	// Print extra fields analysis for supported types
	fmt.Println("\n" + strings.Repeat("=", 100))
	fmt.Println("FIELD COVERAGE ANALYSIS (fields in JSON not yet in structs)")
	fmt.Println(strings.Repeat("=", 100))

	hasExtraFields := false
	for _, key := range sortedKeys {
		s := stats[key]
		if len(s.ExtraFields) > 0 {
			hasExtraFields = true
			fmt.Printf("\n%s:\n", key)

			// Sort extra fields by count
			var fieldNames []string
			for f := range s.ExtraFields {
				fieldNames = append(fieldNames, f)
			}
			sort.Slice(fieldNames, func(i, j int) bool {
				return s.ExtraFields[fieldNames[i]] > s.ExtraFields[fieldNames[j]]
			})

			for _, f := range fieldNames {
				fmt.Printf("  %-30s %d occurrences\n", f, s.ExtraFields[f])
			}
		}
	}
	if !hasExtraFields {
		fmt.Println("\n  (all fields covered)")
	}

	fmt.Println("\n" + strings.Repeat("=", 100))
}

// Envelope fields that can appear on any message type
var envelopeFields = map[string]bool{
	"type": true, "uuid": true, "parentUuid": true, "timestamp": true,
	"isSidechain": true, "userType": true, "cwd": true,
	"sessionId": true, "version": true, "gitBranch": true, "requestId": true,
	"slug": true, "agentId": true,
}

// knownFields lists fields we expect for each message type (beyond envelope fields)
var knownFieldsByType = map[string]map[string]bool{
	"user": {
		"message": true, "toolUseResult": true, "sourceToolAssistantUUID": true,
	},
	"assistant": {
		"message": true,
	},
	"system": {
		"subtype": true, "content": true, "level": true, "isMeta": true,
		"durationMs": true, "compactMetadata": true, "logicalParentUuid": true,
		// init fields
		"session_id": true, "tools": true, "mcp_servers": true,
		"model": true, "permissionMode": true, "slash_commands": true,
		"apiKeySource": true, "claude_code_version": true, "output_style": true,
		"agents": true, "skills": true, "plugins": true,
		// api_error fields
		"error": true, "maxRetries": true, "retryAttempt": true, "retryInMs": true, "cause": true,
	},
	"result": {
		"subtype": true, "is_error": true, "result": true, "num_turns": true,
		"duration_ms": true, "duration_api_ms": true, "total_cost_usd": true,
		"usage": true, "modelUsage": true, "session_id": true,
	},
	"progress": {
		"data": true, "toolUseID": true, "parentToolUseID": true,
	},
	"summary": {
		"summary": true, "leafUuid": true,
	},
	"custom-title": {
		"customTitle": true,
	},
	"tag": {
		"tag": true,
	},
	"agent-name": {
		"agentName": true, "agentColor": true,
	},
	"queue-operation": {
		"operation": true, "content": true,
	},
	"file-history-snapshot": {
		"messageId": true, "snapshot": true, "isSnapshotUpdate": true,
	},
}

func checkExtraFields(rawMap map[string]interface{}, msgType string, extraFields map[string]int) {
	knownFields := knownFieldsByType[msgType]

	for k := range rawMap {
		// Skip envelope fields (common to all messages)
		if envelopeFields[k] {
			continue
		}
		// Skip type-specific known fields
		if knownFields != nil && knownFields[k] {
			continue
		}
		extraFields[k]++
	}
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-3] + "..."
}

func percent(part, total int) float64 {
	if total == 0 {
		return 0
	}
	return float64(part) * 100 / float64(total)
}
