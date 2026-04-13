package agentrunner

import (
	"bytes"
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// AgentDef represents a parsed agent definition from a markdown file.
type AgentDef struct {
	Name     string `yaml:"name"`
	Agent    string `yaml:"agent"`
	Trigger  string `yaml:"trigger"`
	Schedule string `yaml:"schedule,omitempty"`
	Path     string `yaml:"path,omitempty"`
	Enabled  *bool  `yaml:"enabled,omitempty"`
	Prompt   string `yaml:"-"` // markdown body below frontmatter
	File     string `yaml:"-"` // source filename
}

var separator = []byte("---")

// ParseAgentDef parses a markdown file with YAML frontmatter delimited by
// "---" lines. It extracts the frontmatter, unmarshals it into an AgentDef,
// sets defaults, and validates required fields.
func ParseAgentDef(data []byte, filename string) (*AgentDef, error) {
	frontmatter, body, err := splitFrontmatter(data)
	if err != nil {
		return nil, fmt.Errorf("parsing %s: %w", filename, err)
	}

	var def AgentDef
	if err := yaml.Unmarshal(frontmatter, &def); err != nil {
		return nil, fmt.Errorf("parsing %s frontmatter: %w", filename, err)
	}

	// Defaults
	if def.Enabled == nil {
		t := true
		def.Enabled = &t
	}

	def.Prompt = strings.TrimSpace(string(body))
	def.File = filename

	// Validation
	if def.Name == "" {
		return nil, fmt.Errorf("parsing %s: missing required field \"name\"", filename)
	}
	if def.Agent == "" {
		return nil, fmt.Errorf("parsing %s: missing required field \"agent\"", filename)
	}
	if def.Trigger == "" {
		return nil, fmt.Errorf("parsing %s: missing required field \"trigger\"", filename)
	}
	if def.Trigger == "cron" && def.Schedule == "" {
		return nil, fmt.Errorf("parsing %s: trigger \"cron\" requires a \"schedule\"", filename)
	}
	if isFileTrigger(def.Trigger) && def.Path == "" {
		return nil, fmt.Errorf("parsing %s: file trigger %q requires a \"path\" glob pattern", filename, def.Trigger)
	}

	return &def, nil
}

func isFileTrigger(trigger string) bool {
	switch trigger {
	case "file.created", "file.changed", "file.moved", "file.deleted":
		return true
	}
	return false
}

// splitFrontmatter splits data at the YAML frontmatter delimiters.
// It expects the file to start with "---\n" and contain a closing "---\n".
func splitFrontmatter(data []byte) (frontmatter, body []byte, err error) {
	data = bytes.TrimLeft(data, "\n")

	if !bytes.HasPrefix(data, separator) {
		return nil, nil, fmt.Errorf("missing opening frontmatter delimiter")
	}

	// Skip the opening "---" line
	rest := data[len(separator):]
	rest = bytes.TrimPrefix(rest, []byte("\n"))

	idx := bytes.Index(rest, separator)
	if idx < 0 {
		return nil, nil, fmt.Errorf("missing closing frontmatter delimiter")
	}

	frontmatter = rest[:idx]
	body = rest[idx+len(separator):]
	// Trim the newline right after closing ---
	body = bytes.TrimPrefix(body, []byte("\n"))

	return frontmatter, body, nil
}
