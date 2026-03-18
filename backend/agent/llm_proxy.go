package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ProxyLLMClient implements LLMClient by calling the MyLifeDB LLM proxy.
// This routes LLM requests through the local proxy which injects real
// provider credentials, keeping API keys out of agent code.
type ProxyLLMClient struct {
	baseURL    string // e.g., "http://localhost:12345"
	proxyToken string // ephemeral auth token for the proxy
	model      string // default model
}

// NewProxyLLMClient creates an LLM client that calls the local LLM proxy.
func NewProxyLLMClient(baseURL, proxyToken, model string) *ProxyLLMClient {
	return &ProxyLLMClient{
		baseURL:    baseURL,
		proxyToken: proxyToken,
		model:      model,
	}
}

// Complete performs a chat completion via the LLM proxy using OpenAI format.
func (c *ProxyLLMClient) Complete(ctx context.Context, req CompletionRequest) (*CompletionResult, error) {
	model := req.Model
	if model == "" {
		model = c.model
	}

	// Build OpenAI-format messages
	var messages []map[string]interface{}

	if req.System != "" {
		messages = append(messages, map[string]interface{}{
			"role":    "system",
			"content": req.System,
		})
	}

	for _, msg := range req.Messages {
		switch msg.Role {
		case "user":
			if msg.ToolResultID != "" {
				messages = append(messages, map[string]interface{}{
					"role":         "tool",
					"content":      msg.Content,
					"tool_call_id": msg.ToolResultID,
				})
			} else {
				messages = append(messages, map[string]interface{}{
					"role":    "user",
					"content": msg.Content,
				})
			}
		case "assistant":
			m := map[string]interface{}{
				"role":    "assistant",
				"content": msg.Content,
			}
			if len(msg.ToolUse) > 0 {
				var toolCalls []map[string]interface{}
				for _, tool := range msg.ToolUse {
					argsJSON, _ := json.Marshal(tool.Input)
					toolCalls = append(toolCalls, map[string]interface{}{
						"id":   tool.ID,
						"type": "function",
						"function": map[string]interface{}{
							"name":      tool.Name,
							"arguments": string(argsJSON),
						},
					})
				}
				m["tool_calls"] = toolCalls
			}
			messages = append(messages, m)
		}
	}

	// Build tools
	var tools []map[string]interface{}
	for _, toolDef := range req.Tools {
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
		tools = append(tools, map[string]interface{}{
			"type": "function",
			"function": map[string]interface{}{
				"name":        toolDef.Name,
				"description": toolDef.Description,
				"parameters":  params,
			},
		})
	}

	maxTokens := req.MaxTokens
	if maxTokens == 0 {
		maxTokens = 2048
	}

	body := map[string]interface{}{
		"model":       model,
		"messages":    messages,
		"max_tokens":  maxTokens,
		"temperature": 0.7,
	}
	if len(tools) > 0 {
		body["tools"] = tools
	}

	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	log.Info().
		Str("model", model).
		Int("messages", len(messages)).
		Int("tools", len(tools)).
		Msg("llm proxy completion request")

	// Call proxy
	url := c.baseURL + "/api/openai/v1/chat/completions"
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyJSON))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.proxyToken)

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("proxy request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		log.Error().
			Int("status", resp.StatusCode).
			Str("body", string(respBody)).
			Msg("llm proxy error")
		return nil, fmt.Errorf("proxy returned %d: %s", resp.StatusCode, string(respBody))
	}

	// Parse OpenAI-format response
	var apiResp struct {
		Choices []struct {
			Message struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Type     string `json:"type"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}

	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	if len(apiResp.Choices) == 0 {
		return &CompletionResult{}, nil
	}

	choice := apiResp.Choices[0]
	result := &CompletionResult{
		Content: choice.Message.Content,
	}

	for _, tc := range choice.Message.ToolCalls {
		var input map[string]interface{}
		if tc.Function.Arguments != "" {
			json.Unmarshal([]byte(tc.Function.Arguments), &input)
		}
		result.ToolUse = append(result.ToolUse, ToolUse{
			ID:    tc.ID,
			Name:  tc.Function.Name,
			Input: input,
		})
	}

	log.Info().
		Str("content", result.Content).
		Int("toolUse", len(result.ToolUse)).
		Int("promptTokens", apiResp.Usage.PromptTokens).
		Int("completionTokens", apiResp.Usage.CompletionTokens).
		Msg("llm proxy completion response")

	return result, nil
}
