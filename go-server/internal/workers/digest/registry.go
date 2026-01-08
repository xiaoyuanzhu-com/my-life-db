package digest

import (
	"sync"
)

// Registry manages all registered digesters
type Registry struct {
	digesters []Digester
	mu        sync.RWMutex
}

// GlobalRegistry is the global digester registry
var GlobalRegistry = &Registry{}

// Register adds a digester to the registry
func (r *Registry) Register(d Digester) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.digesters = append(r.digesters, d)
}

// GetAll returns all registered digesters in order
func (r *Registry) GetAll() []Digester {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]Digester, len(r.digesters))
	copy(result, r.digesters)
	return result
}

// Get returns a digester by name
func (r *Registry) Get(name string) Digester {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, d := range r.digesters {
		if d.Name() == name {
			return d
		}
	}
	return nil
}

// GetDigesterInfo returns information about all registered digesters
func (r *Registry) GetDigesterInfo() []map[string]interface{} {
	r.mu.RLock()
	defer r.mu.RUnlock()

	result := make([]map[string]interface{}, 0, len(r.digesters))
	for _, d := range r.digesters {
		outputs := d.GetOutputDigesters()
		if len(outputs) == 0 {
			outputs = []string{d.Name()}
		}

		result = append(result, map[string]interface{}{
			"name":        d.Name(),
			"label":       d.Label(),
			"description": d.Description(),
			"outputs":     outputs,
		})
	}
	return result
}

// InitializeRegistry registers all digesters
func InitializeRegistry() {
	// Register digesters in dependency order

	// Content extraction digesters (run first)
	GlobalRegistry.Register(&URLCrawlDigester{})
	GlobalRegistry.Register(&DocToMarkdownDigester{})
	GlobalRegistry.Register(&DocToScreenshotDigester{})
	GlobalRegistry.Register(&ImageOCRDigester{})
	GlobalRegistry.Register(&ImageCaptioningDigester{})
	GlobalRegistry.Register(&ImageObjectsDigester{})
	GlobalRegistry.Register(&SpeechRecognitionDigester{})

	// Secondary processing (depends on content extraction)
	GlobalRegistry.Register(&URLCrawlSummaryDigester{})
	GlobalRegistry.Register(&SpeechRecognitionCleanupDigester{})
	GlobalRegistry.Register(&SpeechRecognitionSummaryDigester{})
	GlobalRegistry.Register(&SpeakerEmbeddingDigester{})

	// Tags and search (depends on text content being available)
	GlobalRegistry.Register(&TagsDigester{})
	GlobalRegistry.Register(&SearchKeywordDigester{})
	GlobalRegistry.Register(&SearchSemanticDigester{})

	logger.Info().Int("count", len(GlobalRegistry.digesters)).Msg("digesters registered")
}
