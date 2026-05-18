// Shared scope helpers for the per-protocol surface handlers.
//
// Phase 0's Store.Create rejects credentials with !=1 scope, so each
// integration credential carries exactly one scope. The helpers here
// answer the two questions every surface handler asks:
//
//   - PickScopePath: "what's the on-disk folder this credential is bound to?"
//   - ScopesAllowFamily: "is the credential's scope family a strict superset
//     of the family the handler needs (read vs write)?"
package integrations

// PickScopePath returns the path of the first scope in the set that has one
// (i.e. files.read / files.write). Phase 0's Store.Create rejects credentials
// with !=1 scope, so this is effectively "the path of the credential's only
// scope". Returns "" if no path-bearing scope is present (a corrupted row).
func PickScopePath(ss ScopeSet) string {
	for _, s := range ss {
		if PathFamily(s.Family) {
			return s.Path
		}
	}
	return ""
}

// ScopesAllowFamily reports whether any scope in the set has the given
// family. Path containment is handled separately by the caller (typically
// via the per-surface chroot) — this helper only answers "is the credential
// allowed to do this kind of action at all?".
func ScopesAllowFamily(ss ScopeSet, family string) bool {
	for _, s := range ss {
		if s.Family == family {
			return true
		}
	}
	return false
}
