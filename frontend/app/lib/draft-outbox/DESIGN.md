# draft-outbox — single owner of agent composer input safety

> **Charter**: nothing the user types in the agent composer is ever lost.
> If anything ever is, this module is at fault.

## Mental model (what the user experiences)

**"Input in the composer is simply safe."** That's the entire user-facing
promise. The user does not see queued indicators, reconnecting spinners,
disabled send buttons, or any affordance that asks them to think about
connection state. They type. They hit send. The message arrives — now or
when the connection comes back. This module's job is to make that
invisible promise true.

The user only ever sees something from this module on **genuine,
unrecoverable failure** (e.g. server explicitly rejected the prompt with
a non-retryable error). Transient network/auth blips are handled silently.

## Scope

This module owns:

1. **Drafts** — text the user is typing in the composer, per session.
2. **Outbox** — prompts the user has submitted but the server has not yet
   acknowledged.
3. **Composer ↔ network sequencing** — when to clear, when to restore.

It does *not* own:

- WebSocket transport (lives in `use-agent-websocket.ts`).
- Message rendering / Thread UI (lives in `assistant-ui/thread.tsx`).
- File attachments / uploads (lives in `lib/send-queue/`).
- Authentication / token refresh (lives in `auth-context.tsx` + `fetch-with-refresh.ts`).

The module talks to those layers through a narrow signal interface (below).
If a draft or pending send is ever lost, the bug is in this module — not in
the composer, not in the WebSocket layer, not in assistant-ui.

## Failure modes today (what we're replacing)

1. Multiple sources of truth (composer state, `pendingComposerText`,
   `localStorage[agent-input:*]`) kept in sync via React effects → races.
2. Persist effect treats `text === ""` as "user cleared draft, delete it",
   but assistant-ui's auto-clear after submit also produces `""`.
3. Failure recovery (`pendingComposerText`) is React state — does not
   survive remount / refresh / auth bounce.
4. `sendPrompt()` returning `false` when WS is closed is silent — no UI
   indication, send button stays enabled, user assumes message was sent.
5. Draft is cleared on `ws.send()` accepting bytes, not on server ack —
   if the WS dies after `send()` but before server got the bytes, lost.

## Core invariants

These are the "this module is correct" assertions. Tested in unit tests,
asserted in dev builds:

- **I1** — At every moment, every character the user has typed lives in
  durable storage **or** in the composer text **or both**. Never neither.
- **I2** — A draft is removed from storage only after either (a) the user
  explicitly clears it, or (b) the corresponding outbox item has been
  acknowledged by the server.
- **I3** — An outbox item is removed only after the server acks it with a
  matching `clientId`. Never on `ws.send()` returning truthy. Never on
  composer auto-clear. Never on disconnect.
- **I4** — On mount, if storage holds a draft for the current session, the
  composer is restored to it before any keystroke can be lost.
- **I5** — On mount, if storage holds outbox items for the current session,
  they are either auto-flushed (when WS opens) or surfaced to the user.
  They are never silently dropped.
- **I6** — Every state transition is logged with `[draft-outbox]` tag, the
  session id, and the clientId (if any).

If any of these is violated, treat it as a P0 bug in this module.

## Module API (signals in / signals out)

The module exposes a `DraftOutbox` instance per session. Other layers talk
to it only through these signals — no direct state access.

### Signals IN (this module consumes)

| Signal | Caller | When | Effect |
|---|---|---|---|
| `mountSession(sessionId)` | agent route | session route mounts | loads draft + outbox for session, emits `draftRestored` if any |
| `unmountSession(sessionId)` | agent route | session route unmounts | flushes any pending storage writes, stops listeners |
| `userTyped(text)` | composer onChange | every keystroke | writes draft to storage (debounced ~50ms, flushed on visibilitychange) |
| `userSubmitted(payload)` | composer onSubmit | user hits Send | enqueues outbox item, generates `clientId`, clears draft, returns `clientId`; triggers flush if WS open |
| `userDiscardedDraft()` | "clear" button | explicit clear | removes draft from storage |
| `connectionChanged(state)` | WS hook | WS state change | `'open'` triggers flush; `'closed'` marks inflight items as pending |
| `serverAcked(clientId)` | onFrame handler | server confirms receipt | removes matching outbox item |
| `serverRejected(clientId, reason)` | onFrame handler | server explicit failure | marks outbox item as failed; surfaces to UI; keeps in storage |
| `transportFailed(clientId, reason)` | WS hook | `ws.send()` threw or returned false mid-flight | reverts inflight → pending |

### Signals OUT (this module emits)

Subscribers register via `outbox.subscribe(handler)` and react to events.

| Signal | Subscriber | Payload | Meaning |
|---|---|---|---|
| `draftRestored` | composer | `{ sessionId, text }` | composer should display this text |
| `draftCleared` | composer | `{ sessionId }` | composer should empty its text |
| `flushItem` | WS hook | `{ clientId, text, attachments }` | transport should send this now |
| `outboxStateChanged` | dev tools / diagnostics | `{ sessionId, pending: number, inflight: number, failed: number }` | counters for diagnostics; **not for user-visible UI** (see "Composer behavior" below) |
| `itemFailed` | toast / banner | `{ clientId, reason, retryable: boolean }` | only fires on **non-retryable** server rejection — the one user-visible failure surface |
| `log` | dev console / telemetry | `{ level, msg, fields }` | structured log line |

### Signals that DO NOT exist (intentionally)

- No "send succeeded" callback from the WS layer. The only success signal
  is `serverAcked` from `onFrame`. `ws.send()` returning truthy is not
  proof of delivery — the WS could die before the bytes reach the server.
- No "draft text changed" effect-based subscription. Only explicit
  `userTyped` calls. This kills the empty-transient-wipe class of bug.

## State machine — outbox item

```
                           userSubmitted
                                │
                                ▼
                          ┌──────────┐
              ┌───────────│ pending  │◀────────┐
              │           └──────────┘         │
   connectionChanged(open)     │               │ transportFailed
              │                │               │
              ▼                │               │
        flushItem emitted      │               │
              │                │               │
              ▼                │               │
          ┌──────────┐         │               │
          │ inflight │─────────┼───────────────┘
          └──────────┘         │
              │                │
   serverAcked  serverRejected │
              │       │        │
              ▼       ▼        │
         removed  ┌──────┐     │
                  │failed│─────┘
                  └──────┘    user clicks Retry → pending
```

States are persisted. After page refresh, an `inflight` item is treated as
`pending` (we don't know if the server got it; idempotency by `clientId`
makes a re-send safe — see Backend changes below).

## State machine — draft

```
       loadDraft(sessionId)
             │
             ▼
     ┌────────────────┐
     │ restored/empty │
     └────────────────┘
        │      │
   userTyped   │ userSubmitted
        │      │
        ▼      ▼
     ┌─────┐  ┌─────────────────────┐
     │ live│  │moved into outbox    │
     └─────┘  │and storage cleared  │
             └──────────────────────┘
        │
   userDiscarded
        │
        ▼
     storage cleared
```

Drafts and outbox items are independent. A user can have *both* a pending
outbox item (waiting to send) and a fresh draft typed afterwards.

## Persistence schema

LocalStorage. Key namespace: `draft-outbox:v1:`.

```
draft-outbox:v1:draft:<sessionId>      → string (raw text)
draft-outbox:v1:outbox:<sessionId>     → JSON OutboxItem[]
draft-outbox:v1:meta                   → JSON { schemaVersion: 1 }
```

`<sessionId>` is `"new-session"` for the pre-session empty state, otherwise
the agent session UUID.

```ts
type OutboxItem = {
  clientId: string          // UUIDv7 or similar, generated client-side
  sessionId: string
  text: string
  attachments: AttachmentRef[]   // references only — blobs go to send-queue
  createdAt: number          // epoch ms
  state: 'pending' | 'inflight' | 'failed'
  attempts: number           // for backoff & "this is wedged" detection
  lastError?: string         // for UI surface + diagnosis
}
```

**Why localStorage and not IndexedDB?** Drafts + outbox metadata are
small, sync-write semantics are easier to reason about, and we have no
binary data here (attachments are just refs to send-queue items, which
already use IndexedDB). If the outbox ever needs to hold large media
inline, we revisit.

**Schema versioning** — `:v1:` in the key namespace lets us migrate
without colliding with old data. On schema bump, write a one-shot
migration in the module init.

**Multi-tab** — out of scope for v1. If the user types in two tabs at
once, last write wins. Document and live with it. (Storage events could
make tabs cooperate later.)

## Observability

Every state transition emits a `log` signal:

```
[draft-outbox] mountSession sessionId=abc draft.len=42 outbox.len=2
[draft-outbox] userTyped sessionId=abc text.len=43
[draft-outbox] userSubmitted sessionId=abc clientId=xyz outbox.len=3
[draft-outbox] connectionChanged state=open  → flushing 3 items
[draft-outbox] flushItem clientId=xyz attempt=1
[draft-outbox] serverAcked clientId=xyz outbox.len=2
[draft-outbox] transportFailed clientId=xyz reason=ws-not-open → reverting to pending
[draft-outbox] mountSession sessionId=abc draft.len=0 outbox.len=2 (recovering)
```

In dev: `console.info` with the `[draft-outbox]` tag. In prod: same; cheap
enough at this volume. Optional later: pipe to a `/api/system/diag`
endpoint for crash-style telemetry.

**Counters** (in-memory, exposed via `outbox.diagnostics()` for dev tools):
- `drafts.persisted`, `drafts.restored`, `drafts.cleared`
- `outbox.enqueued`, `outbox.acked`, `outbox.failed`, `outbox.requeued`
- `signals.in.<name>`, `signals.out.<name>`

If a user reports "I lost my input", the first thing we ask for is the
`[draft-outbox]` log lines. They alone should explain what happened.

## Backend changes required (small, but necessary)

For the outbox to *actually* be safe end-to-end, the server must echo the
client-generated id so we know which prompt was acked.

1. `session.prompt` accepts an optional `clientId` field.
2. `user_message_chunk` frames carry `clientId` back to the client.
3. Backend dedupes by `clientId` per session (keeps last N seen, drops
   duplicates) — makes re-sends after refresh idempotent.

Without this, the outbox can ack on best-effort heuristics (next
`user_message_chunk` frame seen for this session ≈ ack of oldest
inflight item), which works in practice but not under burst sends.
v1 ships with the heuristic; backend change lands soon after.

## Module shape (file layout)

```
frontend/app/lib/draft-outbox/
├── DESIGN.md              ← this doc
├── README.md              ← short usage / API reference
├── index.ts               ← public exports
├── types.ts               ← OutboxItem, signals, events
├── storage.ts             ← localStorage read/write, schema versioning
├── outbox.ts              ← state machine + signal handlers (the core)
├── logger.ts              ← structured logger with [draft-outbox] tag
├── use-draft-outbox.ts    ← React hook: connects component lifecycle
└── outbox.test.ts         ← invariant tests (I1–I6)
```

Public exports (everything callers need; nothing more):

```ts
export { useDraftOutbox } from './use-draft-outbox'
export type { OutboxItem, OutboxState, OutboxSignals } from './types'
```

`useDraftOutbox(sessionId)` returns:

```ts
{
  draft: string
  setDraft: (text: string) => void           // = userTyped
  submit: (payload) => string                // = userSubmitted, returns clientId
  discardDraft: () => void                   // = userDiscardedDraft
  outbox: OutboxItem[]                       // observable state
  retry: (clientId: string) => void
  discardOutboxItem: (clientId: string) => void
  // signals to call from the WS layer:
  onConnectionChanged: (state: ConnState) => void
  onServerAcked: (clientId: string) => void
  onServerRejected: (clientId: string, reason: string) => void
  onTransportFailed: (clientId: string, reason: string) => void
  // for the WS layer to subscribe to flushItem events:
  subscribeFlush: (handler: (item: OutboxItem) => void) => () => void
}
```

The composer becomes thin and **transport-agnostic**:
- `value={draft}` `onChange={(e) => setDraft(e.target.value)}`
- `onSubmit` calls `submit(...)`, never clears its own state
- Send button is **always enabled** when there is text to send. It does
  not reflect WS state. The user's mental model is "input is safe" —
  introducing UI that talks about connection state breaks that promise.
- The composer does not display a "queued" / "reconnecting" / "offline"
  indicator. Outbox items in pending state are invisible to the user;
  they flush silently when the connection comes back.

## Composer behavior (explicit)

- WS open at submit → outbox flushes immediately; user sees their
  message in the conversation as usual.
- WS closed at submit → outbox holds the item; flushes on next
  connectionChanged('open'). User sees... no difference from the open
  case, just a slight delay before the message appears.
- Auth refresh failing during a long idle → connectionChanged stays
  closed; on visibilitychange the WS hook retries refresh + reconnect.
  Outbox waits. No user-visible UI from this module.
- Server explicitly rejected the prompt with a non-retryable error →
  this is the **only** user-visible surface from this module: an
  itemFailed event drives a toast/inline affordance with Retry / Discard.

`use-agent-runtime` keeps its assistant-ui adapter, but the `onNew`
handler shrinks to:

```ts
onNew: async (message) => {
  const text = extractText(message)
  if (!text.trim()) return
  outbox.submit({ text, attachments })
  // Optimistic UI is driven by outbox state, not by adding a fake message here.
}
```

`use-agent-websocket` calls the `on*` handlers and subscribes to
`flushItem` to actually transmit.

## Migration plan (low → high risk)

| Step | Risk | What it does | When to ship |
|---|---|---|---|
| 0 | none | Land this design doc | now |
| 1 | low | **Hotfix**: `DraftPersistenceSync` never `removeItem` based on text-empty alone; only when `userDiscardedDraft` or `serverAcked` paths run. One-file change. | hotfix branch |
| 2 | low | Build `draft-outbox/` module + tests, but don't wire it in yet | parallel branch |
| 3 | medium | Wire composer + `use-agent-runtime` to use the module; remove `pendingComposerText`, remove `DraftPersistenceSync`, remove `useDraftPersistence` | when step 2 has tests passing |
| 4 | medium | Backend `clientId` round-trip + dedup | independent timing |

Step 1 alone defuses the 12-hour-bug. Steps 2–3 are the proper fix and
make this module the single thing to blame. There is no UI step —
"input is simply safe" is invisible by design.

## Testing strategy

Unit tests (jsdom, fake localStorage, fake timers):

- I1: type, kill component, remount → draft restored.
- I2: submit, ack → draft+outbox item gone. Submit, no ack → both still in
  storage after remount.
- I3: submit while WS closed → item is `pending`, not `inflight`. Open WS
  → flush emitted. Ack → removed.
- I4: pre-populate localStorage with draft, mount → composer reads it
  before any keystroke is allowed.
- I5: pre-populate localStorage with outbox, mount, open WS → flush
  emitted in order.
- I6: every public method emits a `log` signal.

Race tests:
- Submit while another submit is mid-flight (burst typing).
- Connection flap during inflight (`closed` → `open` → `closed`).
- Visibility change during inflight.

## Open questions

1. **Cap on outbox size?** If WS is dead for hours and user keeps typing
   prompts, do we cap? Soft limit + warning UI seems right; hard reject
   feels worse than letting the user explicitly clear.
2. **Multi-session interaction.** When user is on session A and sends to
   session B somehow (deep link? unlikely), whose outbox? Per-session is
   the answer; the module doesn't try to be smart about cross-session.
3. **What counts as "acked"** before backend `clientId` echo lands?
   Heuristic: first `user_message_chunk` for the session after `flushItem`
   acks the oldest inflight item with matching text prefix. Acceptable
   for v1; remove the moment backend echoes `clientId`.
4. **Encryption at rest.** localStorage is not encrypted. Drafts may
   contain sensitive prompt content. Out of scope for v1; flag if user
   raises it.
