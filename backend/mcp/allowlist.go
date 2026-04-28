package mcp

// AllowlistEntries returns the Claude Code tool-permission strings for every
// tool registered with the registry, in the form
// `mcp__<ServerName>__<toolName>`. Returned in lexicographic order so the
// generated settings.local.json is diff-friendly across restarts.
func (r *Registry) AllowlistEntries() []string {
	names := r.Names()
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = "mcp__" + ServerName + "__" + n
	}
	return out
}
