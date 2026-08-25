/**
 * update-probe — always-on, allocation-light counters for React render /
 * effect churn.
 *
 * Why this exists: React's "Maximum update depth exceeded" (error #185) is
 * thrown from `getRootForUpdatedFiber` on whatever update happens to be
 * scheduled *after* the 50th consecutive commit that left pending sync-lane
 * work. The component named in the stack is therefore the victim, not the
 * culprit — and in a minified production bundle every frame reads `Nl@…`
 * anyway. Which is exactly what we saw on iOS: a full-screen crash with a
 * stack that identified nothing.
 *
 * String labels passed to `probe()` are literals in our own source, so they
 * survive minification intact. Counting them in a rolling window gives the
 * one thing the stack can't: *which* site was spinning when the crash hit.
 *
 * Cost per call is one Map lookup and two integer writes. It runs in
 * production on purpose — the bug only reproduces on a real phone with a real
 * dictation engine, so a DEV-only probe would never see it.
 */

/** Rolling window. Counts older than this are discarded per-label. */
const WINDOW_MS = 2_000

/**
 * Calls-per-window above which a label is considered "hot" and worth
 * snapshotting. Human typing tops out around 10 chars/sec (~20 renders per
 * window for a two-commit-per-character path); dictation bursts and genuine
 * loops run an order of magnitude above that.
 */
const HOT_THRESHOLD = 60

/** How many labels the snapshot keeps. */
const SNAPSHOT_SIZE = 12

interface Counter {
  /** Calls inside the current window. */
  n: number
  /** Window start (ms, performance.now). */
  since: number
  /** Highest per-window count ever observed for this label. */
  peak: number
}

export interface ProbeSite {
  label: string
  /** Calls in the current (or most recent) window. */
  count: number
  /** Highest per-window count observed for this label since page load. */
  peak: number
}

export interface ProbeSnapshot {
  /** Sites ordered by peak descending. */
  sites: ProbeSite[]
  /** ms since page load when a burst first crossed HOT_THRESHOLD, if ever. */
  firstHotAt: number | null
  /** The label that first crossed the threshold. */
  firstHotLabel: string | null
}

const counters = new Map<string, Counter>()

let firstHotAt: number | null = null
let firstHotLabel: string | null = null

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * Record one occurrence of `label` (a render pass, an effect body, a state
 * write — whatever the call site means by it).
 *
 * Labels must be string literals, not template strings built from data:
 * an unbounded label space would grow the Map without limit.
 */
export function probe(label: string): void {
  const t = now()
  let c = counters.get(label)
  if (c === undefined) {
    c = { n: 0, since: t, peak: 0 }
    counters.set(label, c)
  } else if (t - c.since > WINDOW_MS) {
    // Window rolled over: remember the peak, start counting again.
    if (c.n > c.peak) c.peak = c.n
    c.n = 0
    c.since = t
  }
  c.n += 1
  if (c.n > c.peak) c.peak = c.n
  if (c.n === HOT_THRESHOLD && firstHotAt === null) {
    firstHotAt = t
    firstHotLabel = label
    // One line, once per page load — enough to spot in a remote console
    // without flooding it.
    console.warn(
      `[update-probe] "${label}" ran ${HOT_THRESHOLD}x in ${Math.round(t - c.since)}ms — possible update loop`,
    )
  }
}

/** Current counters, hottest first. Safe to call from an error boundary. */
export function getProbeSnapshot(): ProbeSnapshot {
  const t = now()
  const sites: ProbeSite[] = []
  for (const [label, c] of counters) {
    // A stale window means the site went quiet; report 0 for "now" but keep
    // the peak, which is the interesting number after a crash.
    const count = t - c.since > WINDOW_MS ? 0 : c.n
    sites.push({ label, count, peak: Math.max(c.peak, c.n) })
  }
  sites.sort((a, b) => b.peak - a.peak || b.count - a.count)
  return {
    sites: sites.slice(0, SNAPSHOT_SIZE),
    firstHotAt,
    firstHotLabel,
  }
}

/** Render the snapshot as plain text for the error report / clipboard. */
export function formatProbeSnapshot(snapshot: ProbeSnapshot): string {
  if (snapshot.sites.length === 0) return 'no probe data'
  const lines = snapshot.sites.map(
    (s) => `  ${String(s.peak).padStart(5)} peak / ${String(s.count).padStart(5)} now  ${s.label}`,
  )
  if (snapshot.firstHotLabel) {
    lines.unshift(
      `  first burst: ${snapshot.firstHotLabel} @ ${Math.round(snapshot.firstHotAt ?? 0)}ms`,
    )
  }
  return lines.join('\n')
}

/** Test/debug helper. */
export function resetProbes(): void {
  counters.clear()
  firstHotAt = null
  firstHotLabel = null
}

// Expose for ad-hoc inspection from a remote Safari/Chrome console.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__mldProbe = {
    snapshot: getProbeSnapshot,
    format: () => formatProbeSnapshot(getProbeSnapshot()),
    reset: resetProbes,
  }
}
