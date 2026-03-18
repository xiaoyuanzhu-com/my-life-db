package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SummarizeRequest is the request body for the summarize endpoint
type SummarizeRequest struct {
	Text      string `json:"text" binding:"required"`
	MaxTokens int    `json:"max_tokens"`
}

// SummarizeResponse is the response body for the summarize endpoint
type SummarizeResponse struct {
	Summary string `json:"summary"`
}

// OpenAIRequest represents the request to OpenAI API
type OpenAIRequest struct {
	Model       string          `json:"model"`
	Messages    []OpenAIMessage `json:"messages"`
	MaxTokens   int             `json:"max_tokens,omitempty"`
	Temperature float64         `json:"temperature"`
}

// OpenAIMessage represents a message in the OpenAI API
type OpenAIMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// OpenAIResponse represents the response from OpenAI API
type OpenAIResponse struct {
	Choices []struct {
		Message OpenAIMessage `json:"message"`
	} `json:"choices"`
}

// Summarize generates an AI summary of the provided text.
// Routes through the LLM proxy when configured, otherwise falls back to direct OpenAI.
func (h *Handlers) Summarize(c *gin.Context) {
	var req SummarizeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	cfg := config.Get()

	// Determine LLM endpoint: proxy or direct
	var apiURL, apiKey, model string
	if proxy := h.server.LLMProxy(); proxy != nil && proxy.Token() != "" && (cfg.LLMOpenAIKey != "" || cfg.OpenAIAPIKey != "") {
		// Use LLM proxy
		apiURL = fmt.Sprintf("http://localhost:%d/api/openai/v1/chat/completions", cfg.Port)
		apiKey = proxy.Token()
		model = cfg.OpenAIModel
		if model == "" {
			model = "gpt-4o-mini"
		}
	} else if cfg.OpenAIAPIKey != "" {
		// Direct OpenAI fallback
		apiURL = cfg.OpenAIBaseURL + "/chat/completions"
		apiKey = cfg.OpenAIAPIKey
		model = cfg.OpenAIModel
	} else {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "No LLM provider configured. Set MLD_LLM_OPENAI_KEY or OPENAI_API_KEY.",
		})
		return
	}

	// Set default max tokens if not provided
	maxTokens := req.MaxTokens
	if maxTokens == 0 {
		maxTokens = 300
	}

	// Build the prompt
	prompt := fmt.Sprintf(`Summarize the following transcript into key bullet points.
Focus on main topics, decisions, and action items. Be concise but informative.

Transcript:
%s

Summary:`, req.Text)

	// Build request (OpenAI format — works with both direct and proxy)
	openAIReq := OpenAIRequest{
		Model: model,
		Messages: []OpenAIMessage{
			{
				Role:    "user",
				Content: prompt,
			},
		},
		MaxTokens:   maxTokens,
		Temperature: 0.3,
	}

	reqBody, err := json.Marshal(openAIReq)
	if err != nil {
		log.Error().Err(err).Msg("failed to marshal LLM request")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to prepare request"})
		return
	}

	req2, err := http.NewRequest("POST", apiURL, bytes.NewBuffer(reqBody))
	if err != nil {
		log.Error().Err(err).Msg("failed to create LLM request")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create request"})
		return
	}

	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{}
	resp, err := client.Do(req2)
	if err != nil {
		log.Error().Err(err).Msg("failed to call LLM API")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate summary"})
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Error().Err(err).Msg("failed to read LLM response")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read response"})
		return
	}

	if resp.StatusCode != http.StatusOK {
		log.Error().Int("status", resp.StatusCode).Str("body", string(body)).Msg("LLM API error")
		c.JSON(resp.StatusCode, gin.H{"error": fmt.Sprintf("LLM API error: %s", string(body))})
		return
	}

	var openAIResp OpenAIResponse
	if err := json.Unmarshal(body, &openAIResp); err != nil {
		log.Error().Err(err).Msg("failed to parse LLM response")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to parse response"})
		return
	}

	if len(openAIResp.Choices) == 0 {
		log.Error().Msg("LLM API returned no choices")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No summary generated"})
		return
	}

	c.JSON(http.StatusOK, SummarizeResponse{
		Summary: openAIResp.Choices[0].Message.Content,
	})
}
