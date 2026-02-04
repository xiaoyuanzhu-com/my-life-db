# Streaming Text UX: Smooth Word Appearance & Scrolling

## Problem Statement

When streaming text from Claude (assistant messages, tool outputs, progress updates), the current implementation has two UX issues:

1. **Jittery word appearance**: Words appear instantly ("flash in"), causing a jarring visual experience where "words are jumping like a mess"
2. **Jarring scroll behavior**: As new content pushes old content up, users lose their reading position and must constantly refocus

## Goals

- Words should "pop in" smoothly, feeling natural and polished
- Scrolling should be smooth and predictable, not jarring
- Maintain good performance (no excessive re-renders)
- Keep latency perception low (users should still feel the response is fast)

---

## Part 1: Word Appearance Animation

### Option A: No Animation (Current State)

New text appears instantly as it arrives from the stream.

| Pros | Cons |
|------|------|
| Zero latency | Jittery, hard to read while streaming |
| Simplest implementation | Feels unpolished |
| No CPU overhead | Words "flash in" jarringly |

### Option B: Simple Fade-In

New words fade from `opacity: 0` to `opacity: 1`.

```css
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
.new-word { animation: fadeIn 150ms ease-out forwards; }
```

| Pros | Cons |
|------|------|
| Simple to implement | Somewhat flat/boring |
| Low CPU overhead | Doesn't have "pop" feel |
| Subtle, not distracting | |

### Option C: Fade + Blur In (Recommended)

New words start blurry and transparent, then sharpen into focus. Creates a "materializing" effect.

```css
@keyframes fadeBlurIn {
  from {
    opacity: 0;
    filter: blur(4px);
  }
  to {
    opacity: 1;
    filter: blur(0);
  }
}
.new-word { animation: fadeBlurIn 120ms ease-out forwards; }
```

| Pros | Cons |
|------|------|
| Polished, modern feel | Slightly higher GPU usage |
| Creates sense of "thinking/generating" | Need to track old vs new content |
| Used by FlowToken library | |
| Words feel like they "pop into existence" | |

### Option D: Fade + Scale (Pop Effect)

Words slightly grow as they appear.

```css
@keyframes fadeScaleIn {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
```

| Pros | Cons |
|------|------|
| Satisfying "pop" feel | Can feel busy with lots of words |
| Good for emphasis | May cause minor layout shifts |

### Option E: Fade + Slide Up

Words slide up slightly as they fade in.

```css
@keyframes fadeSlideIn {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

| Pros | Cons |
|------|------|
| Implies upward flow of content | Can feel like too much motion |
| ChatGPT-like feel | Minor layout complexity |

### Recommendation: Option C (Fade + Blur)

**Reasoning:**
- Creates the "words materializing" effect you described
- Blur-to-sharp transition feels like content is "coming into focus"
- Used by production libraries like [FlowToken](https://github.com/Ephibbs/flowtoken)
- GPU-accelerated (filter + opacity), performant
- Duration of 100-150ms is imperceptible as "delay" but smooths the visual

---

## Part 2: Token Batching / Debouncing

Raw token-by-token updates cause excessive re-renders and jittery visuals.

### Option A: No Batching (Current State)

Each WebSocket message triggers immediate state update and re-render.

| Pros | Cons |
|------|------|
| Lowest possible latency | Hundreds of re-renders per second |
| Simple | Freezes UI during fast streaming |
| | Jittery appearance |

### Option B: Fixed Interval Batching (Recommended)

Buffer incoming tokens, flush to UI at fixed intervals (30-50ms).

```tsx
// Buffer tokens without triggering re-renders
const bufferRef = useRef<string[]>([])

// Flush every 30-50ms
useEffect(() => {
  const interval = setInterval(() => {
    if (bufferRef.current.length > 0) {
      setContent(prev => prev + bufferRef.current.join(''))
      bufferRef.current = []
    }
  }, 40) // ~25 updates/second
  return () => clearInterval(interval)
}, [])
```

| Pros | Cons |
|------|------|
| Smooth, readable updates | 30-50ms artificial latency |
| ~25 updates/sec (imperceptible) | Slightly more complex |
| What ChatGPT actually does | |
| Reduces re-renders by 10-50x | |

### Option C: requestAnimationFrame Batching

Sync updates with browser's 60fps refresh cycle.

```tsx
const bufferRef = useRef<string[]>([])
const rafRef = useRef<number | null>(null)

function queueToken(token: string) {
  bufferRef.current.push(token)
  if (!rafRef.current) {
    rafRef.current = requestAnimationFrame(() => {
      setContent(prev => prev + bufferRef.current.join(''))
      bufferRef.current = []
      rafRef.current = null
    })
  }
}
```

| Pros | Cons |
|------|------|
| Synced with display refresh | May batch too aggressively |
| Optimal for animations | 16ms batches may be too frequent |
| Natural frame pacing | |

### Recommendation: Option B (Fixed 40ms Interval)

**Reasoning:**
- [ChatGPT uses 30-50ms batching](https://akashbuilds.com/blog/chatgpt-stream-text-react): "The optimal interval is somewhere between 30ms and 100ms"
- 40ms = 25 updates/second, imperceptible to humans but dramatically smoother
- Decouples network speed from render speed
- Simple to implement and tune

---

## Part 3: Scroll Behavior

### Option A: Instant Scroll (Current via use-stick-to-bottom)

Scroll jumps immediately to show new content.

| Pros | Cons |
|------|------|
| Always see latest content | Jarring jumps |
| Simple | Lose reading position |
| | Users complain about ChatGPT's scroll |

### Option B: CSS Smooth Scroll

Use `scroll-behavior: smooth` or `scrollIntoView({ behavior: 'smooth' })`.

| Pros | Cons |
|------|------|
| Built-in, simple | Fixed duration, not adaptive |
| Decent smoothness | Doesn't handle variable content well |
| | Can feel sluggish or too fast |

### Option C: Velocity-Based Spring Scroll (Recommended)

Dynamic scroll speed based on distance, with spring physics.

From [use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom):
> "Uses velocity-based spring animations... Other libraries use easing functions with durations instead, but these don't work well when you want to stream in new content with variable sizing."

**How it works:**
- Scroll velocity proportional to distance from bottom
- Spring physics for natural deceleration
- Faster when far behind, slower when close
- No overshoot or bounce

| Pros | Cons |
|------|------|
| Adapts to content speed | More complex |
| No jarring jumps | Need to tune spring parameters |
| Powers bolt.new, Cohere | |
| Already using use-stick-to-bottom | |

### Option D: Scroll Only When "Stuck to Bottom"

Only auto-scroll if user was already at bottom. If user scrolled up to read, don't interrupt.

| Pros | Cons |
|------|------|
| Respects user intent | May miss new content |
| No interruption while reading | Need clear "scroll to bottom" affordance |

### Recommendation: Option C + D Combined

**Reasoning:**
- `use-stick-to-bottom` already implements velocity-based spring scrolling
- Combine with "stuck to bottom" detection (already implemented)
- Ensure spring animation is enabled and tuned for smooth feel
- Users at bottom get smooth scroll; users reading history are not interrupted

---

## Implementation Plan

### Phase 1: Token Batching (Low Risk, High Impact)

1. Add 40ms batching interval in `handleMessage` for streaming content
2. Use `useRef` buffer to accumulate tokens without re-renders
3. Flush buffer to state on interval

**Files affected:**
- `frontend/app/components/claude/chat/chat-interface.tsx`

### Phase 2: Word Fade+Blur Animation (Medium Complexity)

1. Track "stable content length" vs "new content"
2. Split rendered content into stable (no animation) and new (animated) spans
3. Add CSS keyframes for fade+blur animation
4. After animation completes, merge new content into stable

**Files affected:**
- `frontend/app/components/claude/chat/message-block.tsx` (MessageContent component)
- `frontend/app/globals.css` (add keyframes)

### Phase 3: Verify Smooth Scrolling (Already Implemented)

1. Verify `use-stick-to-bottom` spring animation is working
2. Tune spring parameters if needed (check library options)
3. Ensure "stuck to bottom" detection works correctly

**Files affected:**
- `frontend/app/components/claude/chat/message-list.tsx`

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Visual jitter during streaming | High | None |
| Re-renders per second during streaming | 50-100+ | ~25 |
| User-perceived latency | Instant but jarring | Smooth but still fast |
| Scroll smoothness | Jumpy | Fluid spring animation |

---

## References

- [ChatGPT streaming implementation analysis](https://akashbuilds.com/blog/chatgpt-stream-text-react)
- [FlowToken - LLM text animation library](https://github.com/Ephibbs/flowtoken)
- [use-stick-to-bottom - AI smooth scrolling](https://github.com/stackblitz-labs/use-stick-to-bottom)
- [Upstash smooth streaming in AI SDK](https://upstash.com/blog/smooth-streaming)
- [Vercel AI SDK smooth streaming](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)
- [Human reading speed research](https://www.sciencedirect.com/science/article/abs/pii/S0749596X19300786) - 238-260 wpm average
