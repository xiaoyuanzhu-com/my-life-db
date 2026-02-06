package agent

import (
	"context"
	"encoding/json"

	"github.com/sashabaranov/go-openai"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/vendors"
)

// LLMClient defines the interface for LLM interactions
type LLMClient interface {
	Complete(ctx context.Context, req CompletionRequest) (*CompletionResult, error)
}

// CompletionRequest represents a request to the LLM
type CompletionRequest struct {
	Model     string
	System    string
	Messages  []Message
	Tools     []ToolDefinition
	MaxTokens int
}

// CompletionResult represents the LLM's response
type CompletionResult struct {
	Content string
	ToolUse []ToolUse
}

// ToolDefinition defines a tool available to the agent
type ToolDefinition struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"input_schema"`
}

// OpenAILLMClient implements LLMClient using OpenAI's API
type OpenAILLMClient struct {
	client *vendors.OpenAIClient
}

// NewOpenAILLMClient creates a new OpenAI LLM client
func NewOpenAILLMClient() *OpenAILLMClient {
	return &OpenAILLMClient{
		client: vendors.GetOpenAIClient(),
	}
}

// Complete performs a chat completion with tool support
func (c *OpenAILLMClient) Complete(ctx context.Context, req CompletionRequest) (*CompletionResult, error) {
	if c.client == nil {
		return nil, nil // OpenAI not configured
	}

	// Build messages
	var messages []openai.ChatCompletionMessage

	// Add system message
	if req.System != "" {
		messages = append(messages, openai.ChatCompletionMessage{
			Role:    openai.ChatMessageRoleSystem,
			Content: req.System,
		})
	}

	// Add conversation messages
	for _, msg := range req.Messages {
		switch msg.Role {
		case "user":
			if msg.ToolResultID != "" {
				// Tool result message
				messages = append(messages, openai.ChatCompletionMessage{
					Role:       openai.ChatMessageRoleTool,
					Content:    msg.Content,
					ToolCallID: msg.ToolResultID,
				})
			} else {
				// Regular user message
				messages = append(messages, openai.ChatCompletionMessage{
					Role:    openai.ChatMessageRoleUser,
					Content: msg.Content,
				})
			}

		case "assistant":
			// Assistant message with optional tool calls
			assistantMsg := openai.ChatCompletionMessage{
				Role:    openai.ChatMessageRoleAssistant,
				Content: msg.Content,
			}

			// Add tool calls if present
			if len(msg.ToolUse) > 0 {
				var toolCalls []openai.ToolCall
				for _, tool := range msg.ToolUse {
					argsJSON, _ := json.Marshal(tool.Input)
					toolCalls = append(toolCalls, openai.ToolCall{
						ID:   tool.ID,
						Type: openai.ToolTypeFunction,
						Function: openai.FunctionCall{
							Name:      tool.Name,
							Arguments: string(argsJSON),
						},
					})
				}
				assistantMsg.ToolCalls = toolCalls
			}

			messages = append(messages, assistantMsg)
		}
	}

	// Build tool definitions
	var tools []openai.Tool
	for _, toolDef := range req.Tools {
		// Convert our InputSchema to OpenAI's Parameters format
		params := map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
			"required":   []string{},
		}

		if toolDef.InputSchema != nil {
			if props, ok := toolDef.InputSchema["properties"].(map[string]interface{}); ok {
				params["properties"] = props
			}
			if required, ok := toolDef.InputSchema["required"].([]string); ok {
				params["required"] = required
			}
		}

		tools = append(tools, openai.Tool{
			Type: openai.ToolTypeFunction,
			Function: &openai.FunctionDefinition{
				Name:        toolDef.Name,
				Description: toolDef.Description,
				Parameters:  params,
			},
		})
	}

	// Build completion request
	maxTokens := req.MaxTokens
	if maxTokens == 0 {
		maxTokens = 2048
	}

	completionReq := openai.ChatCompletionRequest{
		Model:       req.Model,
		Messages:    messages,
		MaxTokens:   maxTokens,
		Temperature: 0.7,
	}

	if len(tools) > 0 {
		completionReq.Tools = tools
	}

	log.Info().
		Str("model", req.Model).
		Int("messageCount", len(messages)).
		Int("toolCount", len(tools)).
		Msg("llm completion request")

	// Call OpenAI
	resp, err := c.client.RawComplete(ctx, completionReq)
	if err != nil {
		log.Error().Err(err).Msg("llm completion failed")
		return nil, err
	}

	if len(resp.Choices) == 0 {
		return &CompletionResult{}, nil
	}

	choice := resp.Choices[0]

	// Extract content
	result := &CompletionResult{
		Content: choice.Message.Content,
	}

	// Extract tool calls
	if len(choice.Message.ToolCalls) > 0 {
		for _, toolCall := range choice.Message.ToolCalls {
			var input map[string]interface{}
			if toolCall.Function.Arguments != "" {
				json.Unmarshal([]byte(toolCall.Function.Arguments), &input)
			}

			result.ToolUse = append(result.ToolUse, ToolUse{
				ID:    toolCall.ID,
				Name:  toolCall.Function.Name,
				Input: input,
			})
		}
	}

	log.Info().
		Str("content", result.Content).
		Int("toolUseCount", len(result.ToolUse)).
		Int("promptTokens", resp.Usage.PromptTokens).
		Int("completionTokens", resp.Usage.CompletionTokens).
		Msg("llm completion response")

	return result, nil
}
