/**
 * draft-outbox — public exports.
 *
 * The composer / runtime / WS-hook layers only ever import from this file.
 * Anything not re-exported here is module-private.
 */

export { useDraftOutbox } from "./use-draft-outbox"
export type { UseDraftOutboxResult } from "./use-draft-outbox"
export { createDraftOutbox } from "./outbox"
export type { DraftOutbox } from "./outbox"
export type {
  AttachmentRef,
  ConnState,
  OutboxAggregateState,
  OutboxDiagnostics,
  OutboxEvent,
  OutboxItem,
  OutboxItemState,
  OutboxSubscriber,
  Unsubscribe,
} from "./types"
