// Agent session lifecycle + view-state types. Single source of truth — every
// frontend file that touches sessionState should import from here, not redefine
// the union locally.

export type SessionLifecycleState =
  | 'archived'
  | 'working'
  | 'idle'
  | 'interrupted'
  | 'cancelled'
  | 'error'

// last_turn_outcome values as persisted by the backend. Note the verb→noun
// asymmetry: backend persists 'errored', the user-facing lifecycle state above
// surfaces it as 'error'. Keep both vocabularies straight at API boundaries.
export type LastTurnOutcome =
  | ''
  | 'completed'
  | 'cancelled'
  | 'interrupted'
  | 'errored'

// Outcomes that are user-actionable (Resume / Dismiss banner shown).
// 'errored' uses the verb form to match the DB column; the banner variant
// renders as 'error'.
export type ActionableOutcome = 'cancelled' | 'interrupted' | 'errored'

export function isActionableOutcome(o: LastTurnOutcome | undefined | null): o is ActionableOutcome {
  return o === 'cancelled' || o === 'interrupted' || o === 'errored'
}
