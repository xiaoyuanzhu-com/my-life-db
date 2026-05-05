# Question Card UX Improvements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add minimize/collapse and auto-jump-to-next-question to `QuestionCard`.

**Architecture:** Both features are self-contained in `question-card.tsx`. Minimize adds an `isMinimized` state that swaps the full card body for a single-line bar. Auto-jump adds a `useRef`-based timeout in `handleOptionSelect` that advances `activeTab` after 300ms for single-select questions.

**Tech Stack:** React, TypeScript, Tailwind CSS, lucide-react icons.

---

### Task 1: Add Minimize State & Button to Header

**Files:**
- Modify: `frontend/app/components/claude/chat/question-card.tsx`

**Step 1: Add imports and state**

Add `useRef` to the React import. Add `Minus`, `ChevronRight` to the lucide import. Add `isMinimized` state:

```tsx
// Line 1 — update import
import { useState, useEffect, useCallback, useRef } from 'react'

// Line 4 — update import
import { Check, X, Minus, ChevronRight } from 'lucide-react'

// After line 18 (after activeTab state)
const [isMinimized, setIsMinimized] = useState(false)
```

**Step 2: Add minimize button left of close button**

Replace the close button block (lines 171-180) with both buttons:

```tsx
        {/* Action buttons */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {/* Minimize button */}
          <button
            type="button"
            onClick={() => setIsMinimized(true)}
            disabled={isDismissing}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Minimize"
          >
            <Minus className="h-4 w-4" />
          </button>

          {/* Close button */}
          <button
            type="button"
            onClick={handleSkip}
            disabled={isDismissing}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
```

**Step 3: Verify**

Run: `cd frontend && npx tsc --noEmit`
Expected: No type errors.

**Step 4: Commit**

```bash
git add frontend/app/components/claude/chat/question-card.tsx
git commit -m "feat(question-card): add minimize button to header"
```

---

### Task 2: Render Minimized View

**Files:**
- Modify: `frontend/app/components/claude/chat/question-card.tsx`

**Step 1: Add minimized bar rendering**

Wrap the existing return JSX in a conditional. When `isMinimized`, render the collapsed bar instead. Replace the entire `return (...)` block:

```tsx
  // Get current question based on active tab
  const currentQuestion = question.questions[activeTab]
  const currentKey = `q${activeTab}`
  const totalQuestions = question.questions.length

  if (isMinimized) {
    return (
      <div
        className={cn(
          !isFirst && 'border-t border-border'
        )}
      >
        <button
          type="button"
          onClick={() => setIsMinimized(false)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
        >
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          <span className="text-[13px] font-medium text-foreground truncate">
            {currentQuestion.header}
          </span>
          {totalQuestions > 1 && (
            <span className="text-[12px] text-muted-foreground flex-shrink-0">
              · {activeTab + 1} of {totalQuestions} questions
            </span>
          )}
        </button>
      </div>
    )
  }

  return (
    // ... existing expanded JSX unchanged ...
  )
```

Note: Also update the `currentQuestion` / `currentKey` lines to add `totalQuestions` (move these above the `if (isMinimized)` block).

**Step 2: Verify**

Run: `cd frontend && npx tsc --noEmit`
Expected: No type errors.

**Step 3: Commit**

```bash
git add frontend/app/components/claude/chat/question-card.tsx
git commit -m "feat(question-card): render minimized collapsed bar"
```

---

### Task 3: Auto-Jump to Next Question on Single-Select

**Files:**
- Modify: `frontend/app/components/claude/chat/question-card.tsx`

**Step 1: Add timeout ref and cleanup**

Add a ref to store the auto-advance timeout, and a cleanup effect:

```tsx
// After the isMinimized state declaration
const autoAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

// Add cleanup effect (after the keyboard shortcut effect)
useEffect(() => {
  return () => {
    if (autoAdvanceRef.current) {
      clearTimeout(autoAdvanceRef.current)
    }
  }
}, [])
```

**Step 2: Add auto-advance logic to handleOptionSelect**

In the single-select branch of `handleOptionSelect`, after setting the answer, schedule a tab advance. The full updated `handleOptionSelect`:

```tsx
  const handleOptionSelect = (
    questionIndex: number,
    optionLabel: string,
    multiSelect: boolean
  ) => {
    const key = `q${questionIndex}`

    // Clear any pending auto-advance
    if (autoAdvanceRef.current) {
      clearTimeout(autoAdvanceRef.current)
      autoAdvanceRef.current = null
    }

    if (multiSelect) {
      // Multi-select: toggle option in array — no auto-advance
      const current = (answers[key] as string[]) || []
      if (current.includes(optionLabel)) {
        setAnswers({
          ...answers,
          [key]: current.filter((o) => o !== optionLabel),
        })
      } else {
        setAnswers({
          ...answers,
          [key]: [...current, optionLabel],
        })
      }
    } else {
      // Single select: toggle (click again to unselect)
      const isDeselecting = answers[key] === optionLabel
      setAnswers({
        ...answers,
        [key]: isDeselecting ? '' : optionLabel,
      })

      // Auto-advance to next question after 300ms (only on selection, not deselection)
      if (!isDeselecting && questionIndex < question.questions.length - 1) {
        autoAdvanceRef.current = setTimeout(() => {
          setActiveTab(questionIndex + 1)
          autoAdvanceRef.current = null
        }, 300)
      }
    }
  }
```

Key details:
- Clear any pending timeout at the start (prevents stale advances if user clicks fast)
- Only advance on selection (not toggle-off)
- Only advance when there's a next question (`questionIndex < length - 1`)
- Advance to `questionIndex + 1` (next question), not `activeTab + 1` (they should be the same, but `questionIndex` is the source of truth)

**Step 3: Clear timeout on manual tab switch**

Update the tab button `onClick` to also clear any pending auto-advance:

```tsx
onClick={() => {
  if (autoAdvanceRef.current) {
    clearTimeout(autoAdvanceRef.current)
    autoAdvanceRef.current = null
  }
  setActiveTab(index)
}}
```

**Step 4: Verify**

Run: `cd frontend && npx tsc --noEmit`
Expected: No type errors.

**Step 5: Commit**

```bash
git add frontend/app/components/claude/chat/question-card.tsx
git commit -m "feat(question-card): auto-advance to next question on single-select"
```

---

### Task 4: Build Verification & Manual Test

**Step 1: Run full typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: Clean — no errors.

**Step 2: Run build**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 3: Manual test checklist**

Test these scenarios in the running app:

1. **Minimize/expand:** Click minimize button → card collapses to one line → click bar → expands back
2. **Minimized bar content:** Shows header + "N of M questions" when multiple questions
3. **Single question minimize:** Shows header only, no "1 of 1 questions"
4. **Auto-jump single-select:** Select an option on Q1 → after 300ms, tab switches to Q2
5. **No auto-jump on deselect:** Click selected option to deselect → stays on same tab
6. **No auto-jump on last question:** Select option on last question → stays put
7. **No auto-jump on multi-select:** Select options on a multi-select question → stays put
8. **Fast clicks:** Rapidly click different options → only advances once (no double-jump)
9. **Manual tab switch during delay:** Select option, then immediately click a different tab → no unwanted jump
10. **Close button still works:** X button still skips the question
11. **Keyboard shortcuts still work:** Escape skips, Enter submits

**Step 4: Commit (if any fixes needed)**

```bash
git add frontend/app/components/claude/chat/question-card.tsx
git commit -m "fix(question-card): address issues from manual testing"
```
