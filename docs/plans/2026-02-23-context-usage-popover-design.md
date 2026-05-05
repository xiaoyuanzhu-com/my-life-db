# Context Usage Popover — CLI-Style Breakdown

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the ring + Used/Buffer/Free/Total popover with a CLI-inspired breakdown list showing cache split, free space, and autocompact buffer.

**Architecture:** Extend `ContextUsage` to carry the three individual token fields + model name. Update the extraction `useMemo` in `chat-interface.tsx` to stop summing them. Rewrite the `PopoverContent` body in `context-usage-indicator.tsx` — remove the ring, show model + summary header + breakdown rows + footnote.

**Tech Stack:** React, Tailwind CSS, existing `Popover` UI component.

---

## Design

Each assistant message already carries per-API-call token usage:

```json
{
  "input_tokens": 16000,
  "cache_creation_input_tokens": 10000,
  "cache_read_input_tokens": 62000
}
```

Currently these are summed into `inputTokens`. This plan surfaces them individually.

### Popover Layout

```
claude-sonnet-4-6 · 88k / 200k (44%)

Cache read              62k (31%)
Cache write             10k  (5%)
New input               16k  (8%)
Free space              79k (40%)
Autocompact buffer      33k (17%)

New input = uncached tokens (latest messages, ephemeral content)

[ Compact conversation ]
```

### Row Definitions

| Label | Value | Source |
|-------|-------|--------|
| Cache read | `cacheReadTokens` | `cache_read_input_tokens` |
| Cache write | `cacheCreationTokens` | `cache_creation_input_tokens` |
| New input | `rawInputTokens` | `input_tokens` |
| Free space | `contextWindow - inputTokens - buffer` | Derived |
| Autocompact buffer | `contextWindow * 0.165` | 16.5% reserved |

---

## Task 1: Extend `ContextUsage` type

**Files:**
- Modify: `frontend/app/components/claude/chat/context-usage-indicator.tsx:13-18`

**Step 1: Update the interface**

Replace lines 13-18:

```typescript
export interface ContextUsage {
  /** Total input tokens (non-cached + cache creation + cache read) */
  inputTokens: number
  /** Context window size from the API */
  contextWindow: number
  /** Non-cached input tokens (usage.input_tokens) */
  rawInputTokens: number
  /** Tokens being cached this call (usage.cache_creation_input_tokens) */
  cacheCreationTokens: number
  /** Tokens served from cache (usage.cache_read_input_tokens) */
  cacheReadTokens: number
  /** Model identifier, e.g. "claude-sonnet-4-6-20250514" */
  modelName?: string
}
```

**Step 2: Verify no type errors**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: Type error in `chat-interface.tsx` (missing new required fields) — confirms the type change propagated.

---

## Task 2: Update extraction in `chat-interface.tsx`

**Files:**
- Modify: `frontend/app/components/claude/chat/chat-interface.tsx:567-577`

**Step 1: Surface individual token fields + modelName**

Replace the assistant-message scan (lines 567-579):

```typescript
    // 2. Get inputTokens from the last main-session assistant message (per-API-call)
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const msg = rawMessages[i]
      if (msg.type === 'system' && msg.subtype === 'compact_boundary') break
      if (msg.type === 'assistant' && msg.message?.usage && !msg.parentToolUseID) {
        const usage = msg.message.usage
        const rawInputTokens = usage.input_tokens || 0
        const cacheCreationTokens = usage.cache_creation_input_tokens || 0
        const cacheReadTokens = usage.cache_read_input_tokens || 0
        const totalInput = rawInputTokens + cacheCreationTokens + cacheReadTokens
        if (totalInput === 0) continue
        return {
          inputTokens: totalInput,
          contextWindow,
          rawInputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          modelName: msg.message.model,
        }
      }
    }
```

**Step 2: Verify no type errors**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors — both files now agree on the shape.

**Step 3: Commit**

```bash
git add frontend/app/components/claude/chat/context-usage-indicator.tsx frontend/app/components/claude/chat/chat-interface.tsx
git commit -m "feat(context-usage): extend ContextUsage with cache split + modelName"
```

---

## Task 3: Rewrite popover body

**Files:**
- Modify: `frontend/app/components/claude/chat/context-usage-indicator.tsx:63-220`

**Step 1: Remove popover ring variables**

Delete lines 63-73 (the `popoverSize`, `popoverStrokeWidth`, `popoverRadius`, `popoverCircumference`, `popoverCombinedDashOffset`, `popoverUsedDashOffset` variables). They are only used inside the popover ring SVG which is being removed.

**Step 2: Add a `formatPercent` helper and a `formatModelName` helper**

Add after the existing `formatTokens` function:

```typescript
/** Format percentage for display */
function formatPercent(tokens: number, total: number): string {
  if (total === 0) return '0%'
  const pct = (tokens / total) * 100
  if (pct < 1 && pct > 0) return '<1%'
  return `${Math.round(pct)}%`
}

/** Format model name for display: claude-sonnet-4-6-20250514 → claude-sonnet-4-6 */
function formatModelName(model?: string): string | undefined {
  if (!model) return undefined
  // Strip date suffix (e.g. -20250514)
  return model.replace(/-\d{8}$/, '')
}
```

**Step 3: Replace the PopoverContent body**

Replace the `PopoverContent` children (lines 146-220, everything inside `<PopoverContent>...</PopoverContent>`) with:

```tsx
        {/* Header: model + summary */}
        <div className="text-sm font-medium text-foreground">
          {formatModelName(usage.modelName) && (
            <span>{formatModelName(usage.modelName)} &middot; </span>
          )}
          <span className="tabular-nums">
            {formatTokens(usedTokens)} / {formatTokens(maxTokens)} tokens ({percentage}%)
          </span>
        </div>

        {/* Breakdown rows */}
        <div className="mt-2 text-xs text-muted-foreground tabular-nums space-y-0.5">
          <div className="flex justify-between">
            <span>Cache read</span>
            <span>{formatTokens(usage.cacheReadTokens)} ({formatPercent(usage.cacheReadTokens, maxTokens)})</span>
          </div>
          <div className="flex justify-between">
            <span>Cache write</span>
            <span>{formatTokens(usage.cacheCreationTokens)} ({formatPercent(usage.cacheCreationTokens, maxTokens)})</span>
          </div>
          <div className="flex justify-between">
            <span>New input</span>
            <span>{formatTokens(usage.rawInputTokens)} ({formatPercent(usage.rawInputTokens, maxTokens)})</span>
          </div>
          <div className="flex justify-between">
            <span>Free space</span>
            <span>{formatTokens(freeTokens)} ({formatPercent(freeTokens, maxTokens)})</span>
          </div>
          <div className="flex justify-between">
            <span>Autocompact buffer</span>
            <span>{formatTokens(autocompactBuffer)} ({formatPercent(autocompactBuffer, maxTokens)})</span>
          </div>
        </div>

        {/* Footnote */}
        <div className="mt-2 text-[11px] text-muted-foreground/60">
          New input = uncached tokens (latest messages, ephemeral content)
        </div>

        {/* Compact button */}
        {onCompact && (
          <button
            type="button"
            onClick={handleCompact}
            disabled={disabled}
            className={cn(
              'w-full mt-3 px-3 py-1.5 rounded-md text-sm',
              'flex items-center justify-center gap-1.5',
              'bg-secondary text-secondary-foreground',
              'hover:bg-secondary/80 transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            <Minimize2 className="h-3.5 w-3.5" />
            Compact conversation
          </button>
        )}
```

Also remove the now-unused `usedPct` and `bufferPct` variables (lines 49-50) — they were only used by the popover ring.

**Step 4: Verify build**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

**Step 5: Visual check**

Run the dev server, open a Claude session, click the context indicator. Verify:
- Model name + summary line shows at top
- 5 breakdown rows with right-aligned values
- Footnote below
- Compact button at bottom
- No ring in popover (trigger ring still works)

**Step 6: Commit**

```bash
git add frontend/app/components/claude/chat/context-usage-indicator.tsx
git commit -m "feat(context-usage): CLI-style breakdown popover with cache split"
```
