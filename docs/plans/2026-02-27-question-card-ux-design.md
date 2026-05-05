# Question Card UX Improvements

Two UX optimizations for the `QuestionCard` component in `question-card.tsx`.

## Feature 1: Minimize Button

Add an `isMinimized` state. A minimize button (chevron-down icon) sits left of the existing close (X) button.

**Minimized view:** A single clickable bar showing `▸ {active tab header} · 1 of N questions`. Click anywhere to expand.

**Expanded view:** Current layout plus the new minimize button in the header row.

**Animation:** Smooth height transition via CSS (`grid-rows` trick or `max-height`).

**Keyboard:** Escape still skips (unchanged). Minimize is mouse-only.

**Scope:** All changes within `question-card.tsx`. No changes to `chat-input.tsx`.

## Feature 2: Auto-Jump to Next Question on Selection

After selecting an option on a single-select question, auto-advance to the next question tab after a 300ms delay.

**Rules:**
- Only for single-select questions (multi-select stays put — user may pick more)
- Only on selection (not deselection/toggle-off)
- Only when there is a next question (last question stays put)
- Timeout cleaned up on unmount or manual tab switch

**Implementation:** In `handleOptionSelect`, after setting the answer for a single-select, schedule `setTimeout(300ms)` to advance `activeTab`. Store the timeout ref for cleanup.

## Files Changed

| File | Change |
|------|--------|
| `question-card.tsx` | Add `isMinimized` state, minimize button, collapsed bar, auto-jump logic |

## Out of Scope

- No changes to `chat-input.tsx` or `chat-interface.tsx`
- No changes to the `AskUserQuestionToolView` (read-only display)
- No changes to animations or types
