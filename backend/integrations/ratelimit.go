// Per-credential token-bucket rate limiter for the non-OAuth ingestion
// surfaces (webhook, WebDAV, S3).
//
// Each credential id is keyed to its own in-memory bucket. The bucket
// fills at refillPerSecond tokens per second up to burstSize, and one
// token is consumed per successful Allow() call. Misbehaving senders see
// a protocol-appropriate 429/503 from the surface handler; well-behaved
// callers never notice the limiter is here.
//
// Bucket map is bounded — when the table grows past maxBuckets we evict
// the oldest entry on the next insert so a malicious client minting
// (or guessing) many credential ids cannot OOM the process. Eviction is
// O(N) on insert past the cap, which is fine because the cap is large
// (10k entries) and overflow is the unhappy path.
//
// The limiter holds no references to the credential rows themselves —
// keys are just opaque ids — so revoked credentials drop out naturally
// when their buckets idle out (and their next request 401s upstream of
// Allow anyway).
package integrations

import (
	"sync"
	"time"
)

// Tunables. Constants today; if/when we expose per-credential or
// per-protocol limits via Settings, these become the defaults and the
// per-credential value gets read alongside Allow.
const (
	// burstSize is the bucket capacity — how many requests can land in
	// quick succession before throttling kicks in.
	burstSize = 60.0

	// refillPerSecond restores tokens to the bucket. With burst=60 and
	// refill=1/sec, the steady-state ceiling is 60 requests / minute.
	refillPerSecond = 1.0

	// maxBuckets caps the in-memory table. When exceeded, the oldest
	// entry by lastRefill is evicted on the next insert. 10k entries
	// at ~64 bytes each is ~640 KB — comfortable for a personal-server
	// instance and still cheap if a misbehaving client pings unique
	// ids in a loop.
	maxBuckets = 10_000
)

// bucket is the per-credential token-bucket state.
//
// `tokens` is float64 so partial refills aren't lost between Allow calls
// (a strict integer would round down and slowly leak capacity).
type bucket struct {
	tokens     float64
	lastRefill time.Time
}

// Limiter is the process-wide rate limiter. Safe for concurrent use.
//
// One mutex guards the whole map; that's fine because Allow holds the
// lock for ~microseconds (just a map lookup + arithmetic). If the
// contention ever shows up in profiles we can shard the map by
// hash(credentialID) % N.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
}

// NewLimiter constructs an empty Limiter with no pre-populated buckets.
// Buckets are created lazily on first Allow() per credential id.
func NewLimiter() *Limiter {
	return &Limiter{
		buckets: make(map[string]*bucket),
	}
}

// Allow reports whether one request from `credentialID` may proceed
// right now, consuming a token if so. Returns false when the bucket is
// empty — callers should respond with the protocol's 429-equivalent.
//
// First call for a new id seeds a full bucket (burstSize tokens) so a
// fresh credential gets the same allowance as a long-established one.
func (l *Limiter) Allow(credentialID string) bool {
	if credentialID == "" {
		// Defensive: an empty id would all share the same bucket,
		// which would be effectively a global rate limit. Better to
		// fail-open (no limit) than to silently coalesce traffic
		// across credentials.
		return true
	}

	now := time.Now()

	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[credentialID]
	if !ok {
		// New bucket — seed full so a fresh credential isn't throttled
		// on its first burst.
		if len(l.buckets) >= maxBuckets {
			l.evictOldestLocked()
		}
		l.buckets[credentialID] = &bucket{
			tokens:     burstSize - 1, // consume one for this request
			lastRefill: now,
		}
		return true
	}

	// Refill: add (elapsed seconds * refillPerSecond) tokens, capped
	// at burstSize.
	elapsed := now.Sub(b.lastRefill).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * refillPerSecond
		if b.tokens > burstSize {
			b.tokens = burstSize
		}
		b.lastRefill = now
	}

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// evictOldestLocked drops the bucket whose lastRefill is the oldest.
// Called from Allow() when the map exceeds maxBuckets. Caller must hold
// l.mu.
func (l *Limiter) evictOldestLocked() {
	var oldestKey string
	var oldestTs time.Time
	first := true
	for k, b := range l.buckets {
		if first || b.lastRefill.Before(oldestTs) {
			oldestKey = k
			oldestTs = b.lastRefill
			first = false
		}
	}
	if oldestKey != "" {
		delete(l.buckets, oldestKey)
	}
}
