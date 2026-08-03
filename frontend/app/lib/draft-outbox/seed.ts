/**
 * draft-outbox — seeding a draft for a session that isn't mounted yet.
 *
 * Normal drafts flow through the mounted `useDraftOutbox` handle. Seeding is
 * the exception: callers want to prefill the *new-session* composer while the
 * hook is still mounted against a different session (the user is sitting in
 * `/agent/:id` and clicks "create an agent with AI"), and they navigate
 * immediately after.
 *
 * Writing through the live handle would be wrong there — it targets the
 * session the user is currently in, so the seed would land in that
 * conversation's draft and surface later as text the user never typed.
 *
 * So this writes storage directly, addressed by an explicit sessionId. The
 * hook reloads the draft from storage during render whenever its sessionId
 * changes (see use-draft-outbox.ts), so the value is already in place on the
 * first render after navigation — no effect ordering to get wrong.
 *
 * If the target session is the one already mounted, this is the wrong tool:
 * storage would be updated but the hook's state would not. Call
 * `outbox.actions.restoreDraft(text)` instead, which persists AND emits
 * `draftRestored` so the live composer picks it up.
 */

import { saveDraft } from "./storage"
import { logger } from "./logger"

/** The sessionId the composer uses before a real session exists. */
export const NEW_SESSION_ID = "new-session"

/**
 * Persist `text` as the draft for `sessionId` without going through a mounted
 * hook. Intended for prefill-then-navigate flows.
 */
export function seedDraft(sessionId: string, text: string): void {
  logger.info("seedDraft", { sessionId, "text.len": text.length })
  saveDraft(sessionId, text)
}
