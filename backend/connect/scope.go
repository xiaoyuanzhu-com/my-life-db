package connect

import (
	"fmt"
	"path"
	"sort"
	"strings"
)

// Scope is a single capability grant. Phase-1 scopes are path-keyed file
// capabilities:
//
//	files.read:<path>     -- HTTP GET on /raw/<path>/* and read of that subtree
//	files.write:<path>    -- HTTP PUT on /raw/<path>/* and write of that subtree
//
// Path is normalized via path.Clean and is always rooted (leading "/"). The
// special path "/" means whole-FS access and is rendered prominently
// ("destructive") on the consent screen.
//
// Future scope families (e.g. mcp:<tool>, posts.write) plug into this same
// type via the Family field; Path is empty for non-path scopes.
type Scope struct {
	Family string // "files.read" | "files.write" | future: "mcp" | "posts.write" | ...
	Path   string // for files.* scopes; empty for others
}

// ScopeSet is an ordered, deduplicated set of Scopes. The wire form is the
// OAuth-standard space-separated string, e.g.
//
//	"files.read:/journal files.write:/apps/acme-notes"
type ScopeSet []Scope

// Known scope families. Add here when introducing a new capability family;
// Parse will reject anything else so typos surface at the authorize boundary.
var knownFamilies = map[string]struct{}{
	"files.read":  {},
	"files.write": {},
}

// PathFamily reports whether a family carries a path argument.
func PathFamily(family string) bool {
	return family == "files.read" || family == "files.write"
}

// String returns the canonical wire form of a single Scope.
func (s Scope) String() string {
	if PathFamily(s.Family) {
		return s.Family + ":" + s.Path
	}
	return s.Family
}

// String returns the canonical space-separated wire form of a ScopeSet.
func (ss ScopeSet) String() string {
	parts := make([]string, len(ss))
	for i, s := range ss {
		parts[i] = s.String()
	}
	return strings.Join(parts, " ")
}

// ParseScopes parses an OAuth scope string. Empty strings are valid (empty set).
// Unknown families return an error so a typo at the authorize boundary is
// caught early — better an obvious error to the developer than a silently
// dropped scope at request time.
func ParseScopes(raw string) (ScopeSet, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ScopeSet{}, nil
	}
	seen := map[string]struct{}{}
	var out ScopeSet
	for _, tok := range strings.Fields(raw) {
		s, err := parseOne(tok)
		if err != nil {
			return nil, err
		}
		key := s.String()
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, s)
	}
	out.Normalize()
	return out, nil
}

func parseOne(tok string) (Scope, error) {
	family, arg, hasColon := strings.Cut(tok, ":")
	if _, ok := knownFamilies[family]; !ok {
		return Scope{}, fmt.Errorf("unknown scope family %q", family)
	}
	if PathFamily(family) {
		if !hasColon || arg == "" {
			return Scope{}, fmt.Errorf("scope %q requires a path", family)
		}
		clean := normalizePath(arg)
		if clean == "" {
			return Scope{}, fmt.Errorf("scope %q has invalid path %q", family, arg)
		}
		return Scope{Family: family, Path: clean}, nil
	}
	if hasColon {
		return Scope{}, fmt.Errorf("scope %q does not take an argument", family)
	}
	return Scope{Family: family}, nil
}

// normalizePath canonicalizes a path: rooted, no ".." segments, no trailing
// slash (except for "/"). Returns "" if the path is invalid.
func normalizePath(p string) string {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	clean := path.Clean(p)
	if strings.Contains(clean, "..") {
		return ""
	}
	return clean
}

// Normalize sorts the set into canonical order: by family, then by path.
// Stable canonical form makes "subset" comparisons and hashing trivial.
func (ss *ScopeSet) Normalize() {
	sort.SliceStable(*ss, func(i, j int) bool {
		if (*ss)[i].Family != (*ss)[j].Family {
			return (*ss)[i].Family < (*ss)[j].Family
		}
		return (*ss)[i].Path < (*ss)[j].Path
	})
}

// Union merges two scope sets, deduplicating and re-normalizing. Used when
// the owner approves additional scopes for an existing client.
func Union(a, b ScopeSet) ScopeSet {
	seen := map[string]struct{}{}
	out := ScopeSet{}
	for _, s := range a {
		k := s.String()
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, s)
	}
	for _, s := range b {
		k := s.String()
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, s)
	}
	out.Normalize()
	return out
}

// IsSubset reports whether every scope in `child` is satisfied by some scope
// in `parent`. Used at re-auth time: if a client's incoming request is a
// subset of the existing grant, we can skip the consent screen.
//
// "Satisfied by" handles path containment for files.* scopes:
//
//	files.read:/journal IS satisfied by files.read:/   (parent covers child)
//	files.read:/        IS NOT satisfied by files.read:/journal
func IsSubset(child, parent ScopeSet) bool {
	for _, c := range child {
		ok := false
		for _, p := range parent {
			if covers(p, c) {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

// Allows reports whether a granted ScopeSet satisfies a specific request:
// the request family must match, and (for path scopes) the granted path
// must be an ancestor (or equal) of the requested path.
func (ss ScopeSet) Allows(family, requestPath string) bool {
	want := Scope{Family: family}
	if PathFamily(family) {
		clean := normalizePath(requestPath)
		if clean == "" {
			return false
		}
		want.Path = clean
	}
	for _, s := range ss {
		if covers(s, want) {
			return true
		}
	}
	return false
}

// covers reports whether parent covers child (parent is at least as broad).
func covers(parent, child Scope) bool {
	if parent.Family != child.Family {
		return false
	}
	if !PathFamily(parent.Family) {
		return true
	}
	return pathContains(parent.Path, child.Path)
}

// pathContains reports whether `parent` is an ancestor of (or equal to)
// `child`. Both must be cleaned/rooted.
func pathContains(parent, child string) bool {
	if parent == "/" || parent == child {
		return true
	}
	return strings.HasPrefix(child, parent+"/")
}

// New returns a Scope after validating it via ParseScopes — handy for tests
// and call sites that want a single scope literal.
func New(family, p string) (Scope, error) {
	if PathFamily(family) {
		return parseOne(family + ":" + p)
	}
	return parseOne(family)
}
