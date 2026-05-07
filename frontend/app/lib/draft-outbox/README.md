# draft-outbox

Single owner of agent composer input safety. If user input is ever lost,
this module is at fault.

**Mental model:** *"input in the composer is simply safe."* The user
never sees queued indicators, reconnecting badges, or disabled send
buttons. Transport state is invisible to them. The module is a contract:
typed text survives, submitted prompts are delivered.

See [`DESIGN.md`](./DESIGN.md) for the full design rationale, signal
contract, state machines, persistence schema, and invariants.

## Public API

```ts
import { useDraftOutbox } from "~/lib/draft-outbox"

function ComposerWiring({ sessionId }: { sessionId: string }) {
  const ob = useDraftOutbox(sessionId)

  // Render-driven
  ob.draft        // string — composer's value
  ob.outbox       // OutboxItem[] — pending/inflight/failed
  ob.aggregate    // { pending, inflight, failed, total }
  ob.connState    // 'open' | 'closed' | 'reconnecting'

  // Composer-driven signals
  ob.setDraft(text)                              // every keystroke
  const clientId = ob.submit({ text })           // user hits Send
  ob.discardDraft()                              // user-driven clear

  // Network-driven signals (call from WS hook / onFrame)
  ob.notifyConnection('open' | 'closed' | 'reconnecting')
  ob.notifyAcked(clientId)
  ob.notifyRejected(clientId, reason)
  ob.notifyTransportFailure(clientId, reason)

  // Outbox UI actions
  ob.retry(clientId)
  ob.discardOutboxItem(clientId)

  // WS hook subscribes to drain pending items
  useEffect(() => ob.subscribeFlush((item) => ws.send(...)), [ob])
}
```

## Logging

Every signal logs with a `[draft-outbox]` tag. Search the console for
that tag if a user reports lost input.

```
[draft-outbox] mountSession sessionId=abc draft.len=42 outbox.len=2
[draft-outbox] userTyped sessionId=abc text.len=43
[draft-outbox] userSubmitted sessionId=abc clientId=xyz outbox.len=3
[draft-outbox] connectionChanged sessionId=abc prev=closed state=open
[draft-outbox] flushItem sessionId=abc clientId=xyz attempt=1
[draft-outbox] serverAcked sessionId=abc clientId=xyz outbox.len=2
```

## Invariants (failures = bugs in this module)

| | Invariant |
|---|---|
| I1 | Every typed character lives in storage OR composer text (or both). |
| I2 | Drafts are removed only by `userDiscardedDraft` or `userSubmitted` (which moves the text to the outbox in the same synchronous step). |
| I3 | Outbox items are removed only by `serverAcked`. |
| I4 | `mountSession` restores draft before any keystroke is accepted. |
| I5 | `mountSession` reads outbox; pending items are flushed on `connectionChanged('open')`. |
| I6 | Every public method emits a structured log line. |

## Tests

A test file is not included in this commit — the frontend has no
test runner wired up yet. Recommended to add `vitest` and port the
test plan from `DESIGN.md` (§ Testing strategy). Until then, the
invariants live in code comments at the top of `outbox.ts`.
