package digest

import (
	"sync"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
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

// digesterOrder defines the explicit execution order of all digesters
// Digesters are executed in this exact order to respect dependencies
var digesterOrder = []Digester{
	// Phase 1: Content extraction (run first)
	&URLCrawlDigester{},
	&DocToMarkdownDigester{},
	&DocToScreenshotDigester{},
	&ImagePreviewDigester{},
	&ImageOCRDigester{},
	&ImageCaptioningDigester{},
	&ImageObjectsDigester{},
	&SpeechRecognitionDigester{},

	// Phase 2: Secondary processing (depends on content extraction)
	&URLCrawlSummaryDigester{},
	&SpeechRecognitionCleanupDigester{},
	&SpeechRecognitionSummaryDigester{},
	&SpeakerEmbeddingDigester{},

	// Phase 3: Tags and search (depends on text content being available)
	&TagsDigester{},
	&SearchKeywordDigester{},
	&SearchSemanticDigester{},
}

// InitializeRegistry registers all digesters in their defined order
func InitializeRegistry() {
	for _, digester := range digesterOrder {
		GlobalRegistry.Register(digester)
	}

	log.Info().Int("count", len(GlobalRegistry.digesters)).Msg("digesters registered")
}
