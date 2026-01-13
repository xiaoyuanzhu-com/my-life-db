package digest

// Config holds digest worker configuration
type Config struct {
	Workers   int // Number of parallel processing goroutines
	QueueSize int // Size of the processing queue

	// External service credentials
	OpenAIAPIKey     string
	OpenAIBaseURL    string
	OpenAIModel      string
	HAIDBaseURL      string
	HAIDAPIKey       string
	HAIDChromeCDPURL string
}
