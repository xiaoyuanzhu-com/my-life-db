// Shared scope helpers for the per-protocol surface handlers.
//
// Phase 0's Store.Create rejects credentials with !=1 scope, so each
// integration credential carries exactly one scope. The helpers here
// answer the two questions every surface handler asks:
//
//   - PickScopePath: "what's the on-disk folder this credential is bound to?"
//   - ScopesAllowFamily: "is the credential's scope family a strict superset
//     of the family the handler needs (read vs write)?"
//
// These were originally inlined in api/webhook.go (Phase 1) and api/webdav.go
// (Phase 2). Phase 3's S3 surface needs the same helpers — extracting them
// up here keeps behavior identical across all three surfaces and avoids a
// fourth copy when a future surface arrives.
package integrations

import "github.com/xiaoyuanzhu-com/my-life-db/connect"

// PickScopePath returns the path of the first scope in the set that has one
// (i.e. files.read / files.write). Phase 0's Store.Create rejects credentials
// with !=1 scope, so this is effectively "the path of the credential's only
// scope". Returns "" if no path-bearing scope is present (a corrupted row).
func PickScopePath(ss connect.ScopeSet) string {
	for _, s := range ss {
		if connect.PathFamily(s.Family) {
			return s.Path
		}
	}
	return ""
}

// ScopesAllowFamily reports whether any scope in the set has the given
// family. Path containment is handled separately by the caller (typically
// via the Connect scope-enforcement middleware) — this helper only answers
// "is the credential allowed to do this kind of action at all?".
//
// Used by surfaces that chroot the credential into its scope folder
// (WebDAV's webdav.Dir, S3's per-credential bucket abstraction): once the
// chroot is in place the only remaining check is whether the credential's
// family is read-or-better when the handler needs read, and write when the
// handler needs write.
func ScopesAllowFamily(ss connect.ScopeSet, family string) bool {
	for _, s := range ss {
		if s.Family == family {
			return true
		}
	}
	return false
}
