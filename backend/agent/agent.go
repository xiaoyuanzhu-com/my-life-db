package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/agent/appclient"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Agent handles inbox file analysis and organization
type Agent struct {
	app   appclient.AppClient
	llm   LLMClient
	model string
}

// NewAgent creates a new agent instance
func NewAgent(app appclient.AppClient, llm LLMClient) *Agent {
	cfg := config.Get()
	model := cfg.OpenAIModel
	if model == "" {
		model = "gpt-4o-mini"
	}

	return &Agent{
		app:   app,
		llm:   llm,
		model: model,
	}
}

// AnalyzeFile analyzes a file and determines its intention
func (a *Agent) AnalyzeFile(ctx context.Context, filePath string) (*Response, error) {
	log.Info().Str("filePath", filePath).Msg("agent analyzing file")

	// Create a new conversation for this analysis
	convID := "auto-" + uuid.New().String()
	conv := &Conversation{
		ID:        convID,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
		Status:    "active",
		Summary:   fmt.Sprintf("Analyzing %s", filePath),
		Messages:  []Message{},
	}

	// Save conversation
	if err := a.app.(*appclient.LocalAppClient).SaveConversation(ctx, conv); err != nil {
		log.Error().Err(err).Msg("failed to save conversation")
	}

	// Add user message requesting analysis
	userMsg := Message{
		ID:             uuid.New().String(),
		ConversationID: convID,
		Role:           "user",
		Content: fmt.Sprintf(
			"Analyze this new file in the inbox and determine what it is: %s\n\nPlease identify the intention (what kind of file it is) and suggest where it should be organized based on the user's guidelines.",
			filePath,
		),
		CreatedAt: time.Now().UTC(),
	}
	conv.Messages = append(conv.Messages, userMsg)

	// Save user message
	if err := a.app.(*appclient.LocalAppClient).SaveMessage(ctx, &userMsg); err != nil {
		log.Error().Err(err).Msg("failed to save user message")
	}

	// Build system prompt
	systemPrompt, err := a.buildSystemPrompt(ctx, filePath)
	if err != nil {
		log.Error().Err(err).Msg("failed to build system prompt")
		return nil, err
	}

	// Build tools
	tools := a.buildTools()

	// Agent loop
	maxTurns := 5
	for turn := 0; turn < maxTurns; turn++ {
		log.Info().Int("turn", turn).Int("messages", len(conv.Messages)).Msg("agent turn")

		// Call LLM
		completion, err := a.llm.Complete(ctx, CompletionRequest{
			Model:     a.model,
			System:    systemPrompt,
			Messages:  conv.Messages,
			Tools:     tools,
			MaxTokens: 2048,
		})
		if err != nil {
			log.Error().Err(err).Msg("llm completion failed")
			return nil, err
		}

		// Check if agent wants to use tools
		if len(completion.ToolUse) == 0 {
			// No tools - final response
			assistantMsg := Message{
				ID:             uuid.New().String(),
				ConversationID: convID,
				Role:           "assistant",
				Content:        completion.Content,
				CreatedAt:      time.Now().UTC(),
			}
			conv.Messages = append(conv.Messages, assistantMsg)

			// Save assistant message
			if err := a.app.(*appclient.LocalAppClient).SaveMessage(ctx, &assistantMsg); err != nil {
				log.Error().Err(err).Msg("failed to save assistant message")
			}

			// Update conversation status
			conv.UpdatedAt = time.Now().UTC()
			conv.Status = "completed"
			if err := a.app.(*appclient.LocalAppClient).SaveConversation(ctx, conv); err != nil {
				log.Error().Err(err).Msg("failed to update conversation")
			}

			// Extract intention from conversation
			intention, _ := a.app.GetFileIntention(ctx, filePath)

			return &Response{
				ConversationID: convID,
				Text:           completion.Content,
				Intention:      intention,
			}, nil
		}

		// Add assistant message with tool use
		assistantMsg := Message{
			ID:             uuid.New().String(),
			ConversationID: convID,
			Role:           "assistant",
			Content:        completion.Content,
			ToolUse:        completion.ToolUse,
			CreatedAt:      time.Now().UTC(),
		}
		conv.Messages = append(conv.Messages, assistantMsg)

		// Save assistant message
		if err := a.app.(*appclient.LocalAppClient).SaveMessage(ctx, &assistantMsg); err != nil {
			log.Error().Err(err).Msg("failed to save assistant message")
		}

		// Execute each tool call
		for _, tool := range completion.ToolUse {
			log.Info().Str("tool", tool.Name).Interface("input", tool.Input).Msg("executing tool")

			result, err := a.executeTool(ctx, convID, tool)

			// Format tool result
			resultContent := formatToolResult(result, err)

			// Add tool result to conversation
			toolResultMsg := Message{
				ID:             uuid.New().String(),
				ConversationID: convID,
				Role:           "user",
				ToolResultID:   tool.ID,
				Content:        resultContent,
				CreatedAt:      time.Now().UTC(),
			}
			conv.Messages = append(conv.Messages, toolResultMsg)

			// Save tool result message
			if err := a.app.(*appclient.LocalAppClient).SaveMessage(ctx, &toolResultMsg); err != nil {
				log.Error().Err(err).Msg("failed to save tool result message")
			}
		}

		// Continue loop - agent will see tool results and decide next step
	}

	return nil, fmt.Errorf("agent exceeded max turns")
}

// executeTool executes a tool call
func (a *Agent) executeTool(ctx context.Context, convID string, tool ToolUse) (interface{}, error) {
	switch tool.Name {
	case "get_file":
		filePath, ok := tool.Input["path"].(string)
		if !ok {
			return nil, fmt.Errorf("missing path parameter")
		}
		return a.app.GetFile(ctx, filePath)

	case "read_guideline":
		return a.app.ReadGuideline(ctx)

	case "get_folder_tree":
		depth := 2
		if d, ok := tool.Input["depth"].(float64); ok {
			depth = int(d)
		}
		return a.app.GetFolderTree(ctx, depth)

	case "save_intention":
		// Extract parameters
		filePath, _ := tool.Input["file_path"].(string)
		intentionType, _ := tool.Input["intention_type"].(string)
		intentionDetails, _ := tool.Input["intention_details"].(string)
		confidence, _ := tool.Input["confidence"].(float64)
		suggestedFolder, _ := tool.Input["suggested_folder"].(string)
		reasoning, _ := tool.Input["reasoning"].(string)

		intention := &FileIntention{
			FilePath:         filePath,
			ConversationID:   convID,
			IntentionType:    intentionType,
			IntentionDetails: intentionDetails,
			Confidence:       confidence,
			SuggestedFolder:  suggestedFolder,
			Reasoning:        reasoning,
		}

		err := a.app.SaveFileIntention(ctx, intention)
		if err != nil {
			return nil, err
		}

		return map[string]interface{}{
			"success": true,
			"id":      intention.ID,
		}, nil

	default:
		return nil, fmt.Errorf("unknown tool: %s", tool.Name)
	}
}

// formatToolResult formats tool execution result as a string
func formatToolResult(result interface{}, err error) string {
	if err != nil {
		return fmt.Sprintf("Error: %v", err)
	}

	// Convert result to JSON for LLM
	jsonBytes, err := json.Marshal(result)
	if err != nil {
		return fmt.Sprintf("Result: %v", result)
	}

	return string(jsonBytes)
}

// buildSystemPrompt builds the system prompt with context
func (a *Agent) buildSystemPrompt(ctx context.Context, filePath string) (string, error) {
	// Read guideline
	guideline, err := a.app.ReadGuideline(ctx)
	if err != nil {
		log.Warn().Err(err).Msg("failed to read guideline")
		guideline = "No guideline available."
	}

	// Get file details
	file, err := a.app.GetFile(ctx, filePath)
	if err != nil {
		log.Error().Err(err).Str("path", filePath).Msg("failed to get file details")
	}

	fileInfo := "File not found"
	if file != nil {
		fileInfo = fmt.Sprintf("Name: %s\nMIME Type: %s\nSize: %d bytes\nCreated: %s\n\n",
			file.Name, file.MimeType, file.Size, file.CreatedAt.Format(time.RFC3339))

		// Add digest content
		fileInfo += "Extracted Content:\n"
		for digester, digest := range file.Digests {
			if digest.Status == "done" && digest.Content != "" {
				fileInfo += fmt.Sprintf("\n[%s]:\n%s\n", digester, digest.Content)
			}
		}
	}

	prompt := fmt.Sprintf(`You are an intelligent file organization assistant for MyLifeDB, a personal knowledge management system.

## Your Task

Analyze the file and determine:
1. **Intention Type** - What kind of file is this? (e.g., receipt, document, note, photo, work log, government document, project file, etc.)
2. **Intention Details** - More specific information about the file's purpose
3. **Suggested Folder** - Where should this file be organized based on the user's guidelines?
4. **Reasoning** - Why this organization makes sense
5. **Confidence** - How confident are you? (0.0-1.0)

## File to Analyze

%s

## User's Organization Guidelines

%s

## Available Tools

- **get_file**: Get detailed file information including extracted text, OCR, and metadata
- **read_guideline**: Read the user's full organization guidelines
- **get_folder_tree**: See the current folder structure
- **save_intention**: Save your analysis (REQUIRED - you must call this when you've determined the intention)

## Process

1. First, use get_file to examine the file details and extracted content
2. Use read_guideline and get_folder_tree to understand the organization system
3. Analyze the file's content and context to determine what it is
4. Choose the most appropriate folder based on the guidelines
5. Call save_intention with your analysis

## Intention Types

Common types:
- receipt, invoice, bill
- government_document, id, certificate
- work_document, work_log, meeting_notes
- personal_note, idea, journal_entry
- photo, screenshot, scan
- project_file, code, design
- health_record, fitness_data
- chat_export, conversation
- book, article, reference

## Guidelines for Organization

- Follow the user's existing patterns closely
- If multiple folders could work, choose the most specific one
- High confidence (>0.9) = strong match to existing patterns
- Medium confidence (0.7-0.9) = reasonable match but some uncertainty
- Low confidence (<0.7) = unclear, may need user input
- Always provide clear reasoning for your suggestion

## Important

- Be thorough in your analysis
- Look at file content, not just filename
- Consider context from the organization guidelines
- Provide helpful, actionable suggestions
- **You MUST call save_intention before finishing**

Begin your analysis now.`, fileInfo, guideline)

	return prompt, nil
}

// buildTools returns the tool definitions available to the agent
func (a *Agent) buildTools() []ToolDefinition {
	return []ToolDefinition{
		{
			Name:        "get_file",
			Description: "Get detailed information about a file including extracted content from digests (OCR, transcription, etc.)",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]interface{}{
						"type":        "string",
						"description": "File path",
					},
				},
				"required": []string{"path"},
			},
		},
		{
			Name:        "read_guideline",
			Description: "Read the user's guideline.md file to understand their organization patterns and folder structure",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "get_folder_tree",
			Description: "Get the library folder structure to see available organization destinations",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"depth": map[string]interface{}{
						"type":        "integer",
						"description": "How deep to traverse (default 2)",
					},
				},
			},
		},
		{
			Name:        "save_intention",
			Description: "Save your analysis of the file's intention and organization suggestion. You MUST call this tool to complete the analysis.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"file_path": map[string]interface{}{
						"type":        "string",
						"description": "Path to the file being analyzed",
					},
					"intention_type": map[string]interface{}{
						"type":        "string",
						"description": "Type of file (e.g., receipt, work_document, photo, etc.)",
					},
					"intention_details": map[string]interface{}{
						"type":        "string",
						"description": "Additional details about what this file is",
					},
					"confidence": map[string]interface{}{
						"type":        "number",
						"description": "Confidence score 0.0-1.0",
					},
					"suggested_folder": map[string]interface{}{
						"type":        "string",
						"description": "Recommended destination folder path",
					},
					"reasoning": map[string]interface{}{
						"type":        "string",
						"description": "Brief explanation of why this organization makes sense (1-2 sentences)",
					},
				},
				"required": []string{"file_path", "intention_type", "confidence", "suggested_folder", "reasoning"},
			},
		},
	}
}
