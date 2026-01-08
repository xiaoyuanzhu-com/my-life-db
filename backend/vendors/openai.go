package vendors

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/sashabaranov/go-openai"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var (
	openaiClient     *OpenAIClient
	openaiClientOnce sync.Once
)

// OpenAIClient wraps the OpenAI client
type OpenAIClient struct {
	client *openai.Client
	model  string
}

// CompletionOptions holds options for completions
type CompletionOptions struct {
	SystemPrompt string
	Prompt       string
	MaxTokens    int
	Temperature  float32
	JSONMode     bool
}

// CompletionResponse represents a completion response
type CompletionResponse struct {
	Content      string
	FinishReason string
	Usage        struct {
		PromptTokens     int
		CompletionTokens int
		TotalTokens      int
	}
}

// GetOpenAIClient returns the singleton OpenAI client
func GetOpenAIClient() *OpenAIClient {
	openaiClientOnce.Do(func() {
		// Load settings from database first, fall back to env vars
		settings, err := db.LoadUserSettings()
		if err != nil {
			log.Error().Err(err).Msg("failed to load user settings for OpenAI")
			return
		}

		apiKey := ""
		baseURL := ""
		model := ""

		if settings.Vendors != nil && settings.Vendors.OpenAI != nil {
			apiKey = settings.Vendors.OpenAI.APIKey
			baseURL = settings.Vendors.OpenAI.BaseURL
			model = settings.Vendors.OpenAI.Model
		}

		// Fall back to env vars if not in DB
		if apiKey == "" {
			cfg := config.Get()
			apiKey = cfg.OpenAIAPIKey
			if baseURL == "" {
				baseURL = cfg.OpenAIBaseURL
			}
			if model == "" {
				model = cfg.OpenAIModel
			}
		}

		if apiKey == "" {
			log.Warn().Msg("OPENAI_API_KEY not configured, OpenAI disabled")
			return
		}

		clientConfig := openai.DefaultConfig(apiKey)
		if baseURL != "" && baseURL != "https://api.openai.com/v1" {
			clientConfig.BaseURL = baseURL
		}

		client := openai.NewClientWithConfig(clientConfig)

		openaiClient = &OpenAIClient{
			client: client,
			model:  model,
		}

		log.Info().Str("model", model).Str("baseURL", baseURL).Msg("OpenAI initialized")
	})

	return openaiClient
}

// Complete performs a chat completion
func (o *OpenAIClient) Complete(opts CompletionOptions) (*CompletionResponse, error) {
	if o == nil {
		return nil, nil
	}

	ctx := context.Background()

	var messages []openai.ChatCompletionMessage

	if opts.SystemPrompt != "" {
		messages = append(messages, openai.ChatCompletionMessage{
			Role:    openai.ChatMessageRoleSystem,
			Content: opts.SystemPrompt,
		})
	}

	messages = append(messages, openai.ChatCompletionMessage{
		Role:    openai.ChatMessageRoleUser,
		Content: opts.Prompt,
	})

	req := openai.ChatCompletionRequest{
		Model:       o.model,
		Messages:    messages,
		MaxTokens:   opts.MaxTokens,
		Temperature: opts.Temperature,
	}

	if opts.JSONMode {
		req.ResponseFormat = &openai.ChatCompletionResponseFormat{
			Type: openai.ChatCompletionResponseFormatTypeJSONObject,
		}
	}

	resp, err := o.client.CreateChatCompletion(ctx, req)
	if err != nil {
		log.Error().Err(err).Msg("completion failed")
		return nil, err
	}

	if len(resp.Choices) == 0 {
		return &CompletionResponse{}, nil
	}

	return &CompletionResponse{
		Content:      resp.Choices[0].Message.Content,
		FinishReason: string(resp.Choices[0].FinishReason),
		Usage: struct {
			PromptTokens     int
			CompletionTokens int
			TotalTokens      int
		}{
			PromptTokens:     resp.Usage.PromptTokens,
			CompletionTokens: resp.Usage.CompletionTokens,
			TotalTokens:      resp.Usage.TotalTokens,
		},
	}, nil
}

// Embed generates embeddings for text
func (o *OpenAIClient) Embed(texts []string) ([][]float32, error) {
	if o == nil {
		return nil, nil
	}

	ctx := context.Background()

	resp, err := o.client.CreateEmbeddings(ctx, openai.EmbeddingRequest{
		Model: openai.AdaEmbeddingV2,
		Input: texts,
	})
	if err != nil {
		log.Error().Err(err).Msg("embedding failed")
		return nil, err
	}

	result := make([][]float32, len(resp.Data))
	for i, item := range resp.Data {
		result[i] = item.Embedding
	}

	return result, nil
}

// ModelInfo represents model metadata from OpenAI API
type ModelInfo struct {
	ID      string `json:"id"`
	OwnedBy string `json:"owned_by,omitempty"`
}

// ListModels returns available models with proper schema matching Node.js
func (o *OpenAIClient) ListModels() (map[string]interface{}, error) {
	if o == nil {
		return map[string]interface{}{"models": []ModelInfo{}}, nil
	}

	ctx := context.Background()

	resp, err := o.client.ListModels(ctx)
	if err != nil {
		return nil, err
	}

	models := make([]ModelInfo, 0, len(resp.Models))
	for _, model := range resp.Models {
		models = append(models, ModelInfo{
			ID:      model.ID,
			OwnedBy: model.OwnedBy,
		})
	}

	return map[string]interface{}{"models": models}, nil
}

// EmbedText is a convenience function to embed a single text
func EmbedText(text string) ([]float32, error) {
	client := GetOpenAIClient()
	if client == nil {
		return nil, nil
	}

	results, err := client.Embed([]string{text})
	if err != nil {
		return nil, err
	}

	if len(results) == 0 {
		return nil, nil
	}

	return results[0], nil
}

// GetOpenAI returns the OpenAI client (wrapper for digest workers)
func GetOpenAI() *OpenAIClient {
	return GetOpenAIClient()
}

// Summarize generates a summary of the text
func (o *OpenAIClient) Summarize(text string) (string, error) {
	if o == nil {
		return "", nil
	}

	resp, err := o.Complete(CompletionOptions{
		SystemPrompt: "You are a helpful assistant that summarizes text concisely.",
		Prompt:       "Please summarize the following text in 2-3 sentences:\n\n" + text,
		MaxTokens:    200,
		Temperature:  0.3,
	})
	if err != nil {
		return "", err
	}

	return resp.Content, nil
}

// CleanupTranscript cleans up a raw transcript
func (o *OpenAIClient) CleanupTranscript(transcript string) (string, error) {
	if o == nil {
		return "", nil
	}

	resp, err := o.Complete(CompletionOptions{
		SystemPrompt: "You are a helpful assistant that cleans up transcripts. Fix punctuation, remove filler words, and format properly.",
		Prompt:       "Please clean up this transcript:\n\n" + transcript,
		MaxTokens:    2000,
		Temperature:  0.2,
	})
	if err != nil {
		return "", err
	}

	return resp.Content, nil
}

// GenerateTags generates tags for the text
func (o *OpenAIClient) GenerateTags(text string) ([]string, error) {
	if o == nil {
		return nil, nil
	}

	systemPrompt := `You are an expert knowledge organizer. Generate 5-10 tags that help classify the content.
Tag format: lowercase with spaces (e.g., "open source"), but honor conventions for proper nouns (e.g., "iOS", "JavaScript").
No hashtags or numbering.
Respond with JSON in format: {"tags": ["tag1", "tag2", ...]}`

	resp, err := o.Complete(CompletionOptions{
		SystemPrompt: systemPrompt,
		Prompt:       "Analyze the following content and produce tags.\n\n" + text,
		MaxTokens:    200,
		Temperature:  0.1,
		JSONMode:     true,
	})
	if err != nil {
		return nil, err
	}

	// Parse JSON from LLM response using robust parser
	parsed, err := parseJSONFromLLMResponse(resp.Content)
	if err != nil {
		log.Error().Err(err).Str("content", resp.Content).Msg("failed to parse tags JSON")
		return []string{}, nil
	}

	return extractTagsFromJSON(parsed, 20), nil
}

// parseJSONFromLLMResponse robustly parses JSON from LLM responses
func parseJSONFromLLMResponse(content string) (interface{}, error) {
	content = strings.TrimSpace(content)

	// Try direct parse first
	var result interface{}
	if err := json.Unmarshal([]byte(content), &result); err == nil {
		return result, nil
	}

	// Try to find JSON in markdown code blocks
	codeBlockRe := regexp.MustCompile("```(?:json)?\\s*\\n?([\\s\\S]*?)\\n?```")
	if matches := codeBlockRe.FindStringSubmatch(content); len(matches) > 1 {
		if err := json.Unmarshal([]byte(strings.TrimSpace(matches[1])), &result); err == nil {
			return result, nil
		}
	}

	// Try to find JSON object
	jsonObjectRe := regexp.MustCompile(`\{[\s\S]*\}`)
	if match := jsonObjectRe.FindString(content); match != "" {
		if err := json.Unmarshal([]byte(match), &result); err == nil {
			return result, nil
		}
	}

	// Try to find JSON array
	jsonArrayRe := regexp.MustCompile(`\[[\s\S]*\]`)
	if match := jsonArrayRe.FindString(content); match != "" {
		if err := json.Unmarshal([]byte(match), &result); err == nil {
			return result, nil
		}
	}

	return nil, fmt.Errorf("unable to parse JSON from LLM response")
}

// extractTagsFromJSON extracts tags array from parsed JSON
func extractTagsFromJSON(parsed interface{}, maxTags int) []string {
	var tags []string

	switch v := parsed.(type) {
	case map[string]interface{}:
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
		for _, tag := range v {
			if s, ok := tag.(string); ok {
				s = strings.TrimSpace(s)
				if s != "" {
					tags = append(tags, s)
				}
			}
		}
	}

	if maxTags > 0 && len(tags) > maxTags {
		tags = tags[:maxTags]
	}

	return tags
}

// GenerateEmbedding generates an embedding for the text
func (o *OpenAIClient) GenerateEmbedding(text string) ([]float32, error) {
	if o == nil {
		return nil, nil
	}

	results, err := o.Embed([]string{text})
	if err != nil {
		return nil, err
	}

	if len(results) == 0 {
		return nil, nil
	}

	return results[0], nil
}
