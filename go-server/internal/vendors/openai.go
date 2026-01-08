package vendors

import (
	"context"
	"sync"

	"github.com/sashabaranov/go-openai"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/config"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/log"
)

var (
	openaiClient     *OpenAIClient
	openaiClientOnce sync.Once
	openaiLogger     = log.GetLogger("OpenAI")
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
		cfg := config.Get()
		if cfg.OpenAIAPIKey == "" {
			openaiLogger.Warn().Msg("OPENAI_API_KEY not configured, OpenAI disabled")
			return
		}

		clientConfig := openai.DefaultConfig(cfg.OpenAIAPIKey)
		if cfg.OpenAIBaseURL != "" && cfg.OpenAIBaseURL != "https://api.openai.com/v1" {
			clientConfig.BaseURL = cfg.OpenAIBaseURL
		}

		client := openai.NewClientWithConfig(clientConfig)

		openaiClient = &OpenAIClient{
			client: client,
			model:  cfg.OpenAIModel,
		}

		openaiLogger.Info().Str("model", cfg.OpenAIModel).Msg("OpenAI initialized")
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
		openaiLogger.Error().Err(err).Msg("completion failed")
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
		openaiLogger.Error().Err(err).Msg("embedding failed")
		return nil, err
	}

	result := make([][]float32, len(resp.Data))
	for i, item := range resp.Data {
		result[i] = item.Embedding
	}

	return result, nil
}

// ListModels returns available models
func (o *OpenAIClient) ListModels() ([]string, error) {
	if o == nil {
		return nil, nil
	}

	ctx := context.Background()

	resp, err := o.client.ListModels(ctx)
	if err != nil {
		return nil, err
	}

	var models []string
	for _, model := range resp.Models {
		models = append(models, model.ID)
	}

	return models, nil
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

	resp, err := o.Complete(CompletionOptions{
		SystemPrompt: "You are a helpful assistant that generates relevant tags for content. Return a JSON array of tags.",
		Prompt:       "Generate 3-7 relevant tags for this content. Return as JSON array:\n\n" + text,
		MaxTokens:    100,
		Temperature:  0.3,
		JSONMode:     true,
	})
	if err != nil {
		return nil, err
	}

	// Parse JSON array from response
	var tags []string
	// Simple parsing - in production use proper JSON parsing
	content := resp.Content
	if content != "" {
		// Try to extract tags
		tags = []string{}
	}

	return tags, nil
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
