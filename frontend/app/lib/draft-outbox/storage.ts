/**
 * draft-outbox — persistence layer.
 *
 * Wraps localStorage with a versioned namespace and JSON encoding. The rest
 * of the module talks only to these functions; if we ever swap to IndexedDB
 * (e.g. to hold inline attachments), it happens here.
 *
 * Failure handling: localStorage may throw in private mode or when quota is
 * exhausted. We log and degrade — drafts/outbox become in-memory only for
 * that session rather than crashing the composer.
 */

import type { OutboxItem } from "./types"
import { logger } from "./logger"

const NS = "draft-outbox:v1"
const META_KEY = `${NS}:meta`

interface MetaShape {
  schemaVersion: number
}

function draftKey(sessionId: string): string {
  return `${NS}:draft:${sessionId}`
}

function outboxKey(sessionId: string): string {
  return `${NS}:outbox:${sessionId}`
}

/** Initialise/migrate persisted state. Idempotent; safe to call on every mount. */
export function initStorage(): void {
  if (typeof window === "undefined") return
  try {
    const raw = localStorage.getItem(META_KEY)
    if (!raw) {
      const meta: MetaShape = { schemaVersion: 1 }
      localStorage.setItem(META_KEY, JSON.stringify(meta))
      return
    }
    const meta = JSON.parse(raw) as MetaShape
    if (meta.schemaVersion !== 1) {
      // Future migrations branch here. v1 → v2 etc.
      logger.warn("unknown schema version, leaving as-is", {
        version: meta.schemaVersion,
      })
    }
  } catch (err) {
    logger.error("initStorage failed", { err: String(err) })
  }
}

// ── Drafts ────────────────────────────────────────────────────────────────

export function saveDraft(sessionId: string, text: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(draftKey(sessionId), text)
  } catch (err) {
    logger.error("saveDraft failed", { sessionId, err: String(err) })
  }
}

export function loadDraft(sessionId: string): string {
  if (typeof window === "undefined") return ""
  try {
    return localStorage.getItem(draftKey(sessionId)) ?? ""
  } catch (err) {
    logger.error("loadDraft failed", { sessionId, err: String(err) })
    return ""
  }
}

export function clearDraft(sessionId: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(draftKey(sessionId))
  } catch (err) {
    logger.error("clearDraft failed", { sessionId, err: String(err) })
  }
}

// ── Outbox ────────────────────────────────────────────────────────────────

export function loadOutbox(sessionId: string): OutboxItem[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(outboxKey(sessionId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Trust the shape — we wrote it ourselves. Coerce inflight→pending on
    // load: an item that was inflight when the page closed is unproven, and
    // server-side clientId dedup will swallow a duplicate if the original
    // actually landed.
    return parsed.map((item: OutboxItem) =>
      item.state === "inflight" ? { ...item, state: "pending" as const } : item,
    )
  } catch (err) {
    logger.error("loadOutbox failed", { sessionId, err: String(err) })
    return []
  }
}

export function saveOutbox(sessionId: string, items: OutboxItem[]): void {
  if (typeof window === "undefined") return
  try {
    if (items.length === 0) {
      localStorage.removeItem(outboxKey(sessionId))
      return
    }
    localStorage.setItem(outboxKey(sessionId), JSON.stringify(items))
  } catch (err) {
    logger.error("saveOutbox failed", {
      sessionId,
      count: items.length,
      err: String(err),
    })
  }
}

/** Test seam — clears all draft-outbox keys. Not used in app code. */
export function _resetForTest(): void {
  if (typeof window === "undefined") return
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(NS)) keys.push(k)
  }
  for (const k of keys) localStorage.removeItem(k)
}
