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

// Summarize generates an AI summary of the provided text
func (h *Handlers) Summarize(c *gin.Context) {
	var req SummarizeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	cfg := config.Get()

	// Check if OpenAI API key is configured
	if cfg.OpenAIAPIKey == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "OpenAI API key not configured. Please set OPENAI_API_KEY environment variable.",
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

	// Build OpenAI API request
	openAIReq := OpenAIRequest{
		Model: cfg.OpenAIModel,
		Messages: []OpenAIMessage{
			{
				Role:    "user",
				Content: prompt,
			},
		},
		MaxTokens:   maxTokens,
		Temperature: 0.3, // Lower temperature for more focused summaries
	}

	// Marshal request
	reqBody, err := json.Marshal(openAIReq)
	if err != nil {
		log.Error().Err(err).Msg("failed to marshal OpenAI request")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to prepare request"})
		return
	}

	// Make request to OpenAI API
	url := cfg.OpenAIBaseURL + "/chat/completions"
	req2, err := http.NewRequest("POST", url, bytes.NewBuffer(reqBody))
	if err != nil {
		log.Error().Err(err).Msg("failed to create OpenAI request")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create request"})
		return
	}

	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Authorization", "Bearer "+cfg.OpenAIAPIKey)

	client := &http.Client{}
	resp, err := client.Do(req2)
	if err != nil {
		log.Error().Err(err).Msg("failed to call OpenAI API")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate summary"})
		return
	}
	defer resp.Body.Close()

	// Read response
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Error().Err(err).Msg("failed to read OpenAI response")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read response"})
		return
	}

	// Check status code
	if resp.StatusCode != http.StatusOK {
		log.Error().Int("status", resp.StatusCode).Str("body", string(body)).Msg("OpenAI API error")
		c.JSON(resp.StatusCode, gin.H{"error": fmt.Sprintf("OpenAI API error: %s", string(body))})
		return
	}

	// Parse response
	var openAIResp OpenAIResponse
	if err := json.Unmarshal(body, &openAIResp); err != nil {
		log.Error().Err(err).Msg("failed to parse OpenAI response")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to parse response"})
		return
	}

	// Extract summary
	if len(openAIResp.Choices) == 0 {
		log.Error().Msg("OpenAI API returned no choices")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No summary generated"})
		return
	}

	summary := openAIResp.Choices[0].Message.Content

	c.JSON(http.StatusOK, SummarizeResponse{
		Summary: summary,
	})
}
