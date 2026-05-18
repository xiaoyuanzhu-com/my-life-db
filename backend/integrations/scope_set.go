// Scope strings for integration credentials.
//
// Each integration credential (webhook / WebDAV / S3) is pinned to exactly
// one path-scoped capability:
//
//	files.read:<path>   — read of that subtree
//	files.write:<path>  — write of that subtree
//
// The Scope/ScopeSet/ParseScopes types here used to live in the deleted
// backend/connect package; they were moved verbatim when MyLifeDB Connect
// (third-party OAuth) was lifted out of the backend. The wire form
// (space-separated "family:path family:path …") is unchanged so existing
// credential rows continue to parse.
package integrations

import (
	"fmt"
	"path"
	"sort"
	"strings"
)

// Scope is a single capability grant for an integration credential.
// Phase-1 scopes are path-keyed file capabilities.
type Scope struct {
	Family string // "files.read" | "files.write"
	Path   string // for files.* scopes; empty for others
}

// ScopeSet is an ordered, deduplicated set of Scopes. The wire form is the
// OAuth-standard space-separated string.
type ScopeSet []Scope

// knownFamilies pins the accepted scope families. ParseScopes rejects
// anything else so typos surface at credential-create time, not at request
// time.
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

// ParseScopes parses an OAuth-style scope string. Empty strings are valid
// (empty set). Unknown families return an error so a typo at the
// credential-create boundary is caught early.
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
func (ss *ScopeSet) Normalize() {
	sort.SliceStable(*ss, func(i, j int) bool {
		if (*ss)[i].Family != (*ss)[j].Family {
			return (*ss)[i].Family < (*ss)[j].Family
		}
		return (*ss)[i].Path < (*ss)[j].Path
	})
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
