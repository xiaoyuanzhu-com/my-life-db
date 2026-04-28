package mcp

import (
	"fmt"
	"sort"
	"sync"
)

// Registry holds the set of tools exposed by the MCP server. Features call
// Register(tool) at server-construction time. Names are unique; duplicate
// registrations panic to surface bugs at startup rather than at runtime.
type Registry struct {
	mu    sync.RWMutex
	tools map[string]Tool
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{tools: map[string]Tool{}}
}

// Register adds a tool. Panics on empty Name, missing Handler, or duplicate
// Name — these are programmer errors, surfaced at startup.
func (r *Registry) Register(t Tool) {
	if t.Name == "" {
		panic("mcp: Register called with empty Tool.Name")
	}
	if t.Handler == nil {
		panic(fmt.Sprintf("mcp: Register tool %q with nil Handler", t.Name))
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.tools[t.Name]; exists {
		panic(fmt.Sprintf("mcp: duplicate tool registration: %q", t.Name))
	}
	r.tools[t.Name] = t
}

// Get returns the tool by name and whether it exists.
func (r *Registry) Get(name string) (Tool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.tools[name]
	return t, ok
}

// Names returns the registered tool names in lexicographic order.
// Used to derive the Claude Code allowlist deterministically.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.tools))
	for name := range r.tools {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// schema is the wire form of a Tool emitted by tools/list.
type schema struct {
	Name         string         `json:"name"`
	Description  string         `json:"description,omitempty"`
	InputSchema  map[string]any `json:"inputSchema"`
	OutputSchema map[string]any `json:"outputSchema,omitempty"`
}

// schemas returns all tools in the form expected by tools/list.
func (r *Registry) schemas() []schema {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]schema, 0, len(r.tools))
	for _, t := range r.tools {
		s := schema{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		}
		if t.OutputSchema != nil {
			s.OutputSchema = t.OutputSchema
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
