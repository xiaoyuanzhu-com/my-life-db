# Claude Code: UI/UX Design System & Implementation Guide

## 1. Core Design Philosophy: "Fluid Terminal"

The interface bridges the gap between a CLI (Command Line Interface) and a rich text document, creating a continuous, cleaner version of a terminal log mixed with a rich-text editor. This is a **content-first**, **chrome-minimal** approach.

### Key Design Principles

*   **No Chat Bubbles:** Messages do not sit within colored "bubbles." User inputs and AI outputs flow linearly like a document, differentiated primarily by content type and subtle indentation rather than heavy containers.
*   **Minimal Chrome:** Almost no borders or boxes around text sections.
*   **Typography-Driven Hierarchy:** Structure is created via font weight, size, and very specific monospaced vs. sans-serif pairings.
*   **Semantic Indentation:** Hierarchy is established through indentation (padding-left) rather than borders or frames.
*   **Monospace Dominance:** Unlike standard chat, monospace fonts are treated as first-class citizens, used not just for code, but for system status, file paths, and tool outputs.
*   **Pastel & Semantic Coding:** Colors are reserved for *status* (red/green diffs) or *syntax* (code highlighting). The rest is neutral grayscale.
*   **Compact Verticality:** Tight line heights and margins to maximize information density.

---

## 2. Color System (Light Mode)

The palette is restrained, relying on high-contrast grays and specific semantic colors for code editing states. The UI uses a specific range of cool grays and distinct "diff" colors.

### Base Colors
| Token | Hex Value | Application |
| :--- | :--- | :--- |
| **$bg-canvas** | `#FFFFFF` | Main page/application background (white). |
| **$bg-subtle** | `#F5F4EE` | User message pill background (warm off-white/beige). |
| **$bg-code-block** | `#F5F5F5` | Background for standard code snippets (block). |
| **$bg-inline** | `#F3F4F6` | Background for inline code snippets. |
| **$accent-edit** | `#FAF9F6` | Very subtle off-white/beige background for large file edit containers. |

### Typography Colors
| Token | Hex Value | Application |
| :--- | :--- | :--- |
| **$text-primary** | `#1A1A1A` / `#111827` | Main user and AI body text (Near Black). |
| **$text-secondary** | `#5F6368` / `#6B7280` | Metadata, file paths, collapsed logs, summary text (Cool Gray). |
| **$text-tertiary** | `#9CA3AF` | Line numbers, subtle dividers. |
| **$text-system** | `#4A4A4A` | System messages or tool outputs (often monospaced). |

### Borders
| Token | Hex Value | Application |
| :--- | :--- | :--- |
| **$border-light** | `#E5E7EB` | Subtle dividers between major sections. |

### Semantic / Diff Colors
| Token | Hex Value | Application |
| :--- | :--- | :--- |
| **$diff-add-bg** | `#E6FFEC` / `#DCFCE7` | Background for added lines (very pale green). |
| **$diff-add-fg** | `#22863A` / `#166534` | Text color for additions (dark green). |
| **$diff-del-bg** | `#FFEBE9` / `#FEE2E2` | Background for deleted lines (very pale red). |
| **$diff-del-fg** | `#CB2431` / `#991B1B` | Text color for deletions (dark red). |
| **$status-alert** | `#D92D20` / `#EF4444` | Red circles/icons for critical issues. |
| **$status-warn** | `#D97706` / `#F59E0B` | Orange circles/icons for warnings. |

---

## 3. Typography & Typesetting

The system uses a pairing of a clean modern Sans-Serif and a highly legible Monospace. The interface strictly defines two distinct font families.

### Font Stacks
*   **Primary (Sans/UI):** `Inter`, `system-ui`, `-apple-system`, `Segoe UI`
    *   *Usage:* Conversational text, list items, headings, body copy
*   **Code (Mono):** `JetBrains Mono`, `Fira Code`, `SF Mono`, `Consolas`, `Menlo`
    *   *Usage:* File paths, tool logs, code blocks, diffs, terminal outputs
    *   *Note:* Ligatures should be enabled for enhanced readability

### Type Scale

| Element | Font-Family | Size | Weight | Line-Height | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **H1 / Title** | Sans | 16-18px | 700 (Bold) | 1.5 | Main section headers |
| **H3 / Bold Header** | Sans | 16px | 600 (Semi-bold) | 1.5 | Used for list headers |
| **Body Text** | Sans | 15px | 400 (Regular) | 1.6 | Optimized for reading density, main conversational text |
| **Metadata** | Mono | 13px | 400 (Regular) | 1.0-1.4 | File paths, timestamps |
| **Inline Code** | Mono | 13-13.5px | 400 (Regular) | 1.4 | Slightly smaller than body to balance visual weight |
| **Code Block** | Mono | 13px | 400 (Regular) | 1.5 | High density, diff views |
| **File Path** | Mono | 13px | 500 (Medium) | 1.0 | Used in diff headers |

### Layout Details
*   **Bullet Points:** Standard bullets (`•`) or Dash (`-`) indented by `24px`
*   **Nested Lists:** Additional `24px` left indentation per level

---

## 4. Component Library & Architecture

The UI is built as a stack of **"Blocks."** The page is a linear stream where each block handles a specific type of content.

### Message-Level Bullets

Each message turn (user and assistant) has a bullet indicator to visually separate conversation turns:

*   **User messages:** No bullet - plain text, left-aligned
*   **Assistant messages:** Gray bullet (`●`) before content
    *   **Color:** $text-secondary (`#5F6368` / `#6B7280`)
    *   **Size:** 13px (unified across all message types)
    *   **Font:** Monospace (ensures consistent bullet size across all contexts)
    *   **Spacing:** 8px gap between bullet and content
    *   **Alignment:** Top-aligned with first line of content
*   **Tool calls:** Status-colored bullets (`●` or `○`)
    *   **Size:** 13px (identical to assistant messages)
    *   **Font:** Monospace (same as assistant message bullets)
    *   **Colors:**
        *   Green (`#22C55E`) - Success/completed
        *   Red (`#D92D20`) - Failed/error
        *   Orange (`#F59E0B`) - Running/permission required
        *   Gray (`#9CA3AF`) - Pending
    *   **Outline circle (`○`)** for pending state, **filled circle (`●`)** for all other states

**Implementation:**

The `MessageDot` component provides unified bullet styling across all message types:

```tsx
// Shared MessageDot component (frontend/app/components/claude/chat/message-dot.tsx)
export function MessageDot({ status = 'assistant' }: MessageDotProps) {
  if (status === 'user') return null

  const getBulletColor = () => {
    if (status === 'assistant') return '#5F6368' // Gray
    if (status === 'failed') return '#D92D20' // Red
    if (status === 'running') return '#F59E0B' // Orange
    if (status === 'pending') return '#9CA3AF' // Gray
    if (status === 'permission_required') return '#F59E0B' // Orange
    return '#22C55E' // Green (success/completed)
  }

  const bulletChar = status === 'pending' ? '○' : '●'

  return (
    <span
      className="select-none font-mono text-[13px] leading-[1.5]"
      style={{ color: getBulletColor() }}
    >
      {bulletChar}
    </span>
  )
}

// Usage in message blocks
<div className="flex items-start gap-2">
  <MessageDot status="assistant" />
  <div className="flex-1 min-w-0">
    <MessageContent content={message.content} />
  </div>
</div>

// Usage in tool blocks
<div className="flex items-start gap-2">
  <MessageDot status={toolCall.status} />
  <div className="flex-1 min-w-0">
    <span className="font-semibold">Bash</span>
    <span className="ml-2">git status</span>
  </div>
</div>
```

### A. The "User Prompt" Block
User input that initiates the conversation or task.

*   **Style:** Minimal warm beige background pill with rounded corners
    *   **Background:** `$bg-subtle` (#F5F4EE in light mode - warm off-white/beige)
    *   **Padding:** `12px 16px` (vertical, horizontal)
    *   **Border-radius:** `12px`
    *   **Max-width:** 85% of container width
    *   **Display:** Inline-block (wraps to content width)
*   **Alignment:** Right-aligned (using flex justify-end on container)
*   **Typography:** Sans-serif, 15px, $text-primary, line-height 1.6
*   **No bullet indicator** - plain text only
*   **Spacing:** `16px` margin-bottom for separation from next message

**Truncation:** Uses [`gradient-fade`](#pattern-gradient-fade) pattern
- Limit: **10 lines** OR **500 characters** (whichever hits first)
- Shows gradient fade overlay with "Show more" button when truncated
- "Show less" button (no gradient) when expanded

### B. The "Status Item" / Issue List
Used to display categorized issues (e.g., Security, Performance, Memory).

*   **Layout:** Flex row, top alignment
*   **Bullet:** Instead of standard bullets, use emojis or colored SVG circles
    *   *Margin-right:* `12px`
*   **Content:** Rich text description
    *   **Bold** used for the category/issue name (e.g., **"Hardcoded credentials"**)
    *   Regular text for the explanation/description

### C. The "Tool Log" / System Action (Collapsible)
Critical component for the "Claude Code" feel. Represents thinking or terminal actions.

*   **State: Collapsed**
    *   Icon: Right-pointing caret `▶` or `>` (Gray, $text-secondary)
    *   Text: Monospace, e.g., `> Read 3 files` or `> Read frontend/components/App.tsx`
    *   Color: $text-secondary
    *   Cursor: Pointer
    *   Interaction: Click to expand/collapse details
*   **State: Expanded**
    *   Icon: Down-pointing caret `▼` or `v`
    *   Content: Reveals the raw tool output or file list below
    *   Indentation: `24px` left indent for nested content
    *   No framing box; it simply pushes content down

### D. The "Structured Response" (Markdown)
Standard AI response formatted as markdown.

*   **Headers:** Bold text (H1-H3 styles from type scale)
*   **Lists:** Standard unordered/ordered lists with `24px` indentation
*   **Inline Code:** Surrounded by single backticks, rendered with `$bg-inline` background and `$text-primary`
*   **Paragraphs:** Uses body text styles with `16px` vertical rhythm

### E. The "File Edit" / Diff View Container (Complex Component)
This is the most visually distinct element, representing suggested changes to a file.

<details>
<summary><strong>📐 Expand for Detailed File Edit / Diff View Specs</strong></summary>

**Container:**
*   Border: `1px solid #E5E7EB` ($border-light)
*   Border-radius: `6-8px`
*   Margin-top: `12px`
*   Background: `$bg-canvas` or `$bg-subtle`
*   Position: Slightly inset from the main text flow

**Header (The "Chrome"):**
*   Padding: `8px 12px`
*   Background: `$bg-subtle` (F9FAFB) or White with bottom border
*   Icon: File type icon (Go, JS, etc.) or generic file icon (`📄`)
    *   Margin-right: `8px`
*   Text: `path/to/file.go` (Monospace, Bold/Medium, 13px)
*   Action Link: "Show more" / "Show less" at bottom (for truncated content)

**The Diff View Grid:**
*   **Layout:** Single-column unified diff view (not side-by-side)
*   **Line Numbers (Gutter):**
    *   Width: Fixed `40px`
    *   Text-align: Right
    *   Padding-right: `12px`
    *   Color: `$text-tertiary` (#9CA3AF)
    *   User-select: `none`
*   **Code Content:**
    *   Font: Monospace, 13px
    *   Padding-left: `12px`
    *   White-space: `pre` (preserve formatting)

**Diff Line Types:**
*   **Context Line:**
    *   Background: White (`$bg-canvas`)
    *   Text opacity: 50% or normal (often dimmed to focus on changes)
    *   No prefix or subtle `  ` prefix
*   **Deleted Line:**
    *   Background: `$diff-del-bg` (#FFEBE9 or #FEE2E2)
    *   Text color: `$diff-del-fg` (#CB2431 or #991B1B)
    *   Prefix: `-` in red
    *   Optional: Strikethrough text decoration
*   **Added Line:**
    *   Background: `$diff-add-bg` (#E6FFEC or #DCFCE7)
    *   Text color: `$diff-add-fg` (#22863A or #166534)
    *   Prefix: `+` in green

**Syntax Highlighting:**
*   Full language-specific syntax highlighting must be applied *on top* of the diff background colors
*   Use a theme compatible with light backgrounds (avoid dark themes)

**Truncation:** Uses [`expandable-content`](#pattern-expandable-content) pattern
- Limit: **5 deleted lines + 5 added lines** by default
- Shows "Show more/less" banner button when truncated

</details>

### F. Inline Code Decoration
Used for variables, paths, or short commands inside prose.

*   **Selection:** Keywords, file paths, variable names, short commands within paragraphs
*   **Styling:**
    ```css
    padding: 2px 5px;
    background-color: #F3F4F6; /* $bg-inline */
    border-radius: 4px;
    font-family: [Monospace Font];
    font-size: 0.9em; /* or 13-13.5px */
    color: #1F2937; /* $text-primary */
    ```

### G. Interactive Components

#### AskUserQuestion (Integrated into Chat Input)
When Claude needs user input via the `AskUserQuestion` tool, the input card "grows upward" to include a question section - **identical pattern to Permission Request**.

**Design Philosophy:**
*   Question UI is integrated directly into the chat input card (not a modal or inline block)
*   Input card expands to accommodate the question content
*   A subtle border separates question section from input section
*   Creates a cohesive, unified experience rather than a disruptive modal
*   Multiple questions stack above the input (if Claude asks multiple at once)

**Layout:**
```
┌──────────────────────────────────────────┐
│ Question Section                          │
│   Claude needs your input                 │
│   ┌────────────────────────────────────┐ │
│   │ {header chip}                      │ │
│   │ {question text}                    │ │
│   └────────────────────────────────────┘ │
│   ○ Option 1: description               │
│   ○ Option 2: description               │
│   Other: [text input                  ]  │
│                     [Skip Esc] [Submit ⏎]│
├──────────────────────────────────────────┤
│ Input Section (dimmed/disabled)          │
│   Waiting for answer...                  │
│   [📎]                            [↑]    │
└──────────────────────────────────────────┘
```

**Question Section:**
*   Padding: `12px`
*   Border-bottom: `1px solid $border-light` (separates from input)

**Header:**
*   Text: "Claude needs your input" (Sans, 14px, $text-primary)
*   Margin-bottom: `8px`

**Question Header Chip:**
*   Background: `$bg-subtle`
*   Border-radius: `4px`
*   Padding: `2px 8px`
*   Font: Sans, 12px, $text-secondary
*   Content: `{question.header}` (e.g., "返回字段", "Auth method")

**Question Text:**
*   Font: Sans, 14px, $text-primary, font-medium
*   Margin-bottom: `12px`

**Options:**
*   Radio buttons (single select) or checkboxes (if multiSelect)
*   Each option as a clickable card:
    *   Border: `1px solid $border-light`, rounded `8px`
    *   Padding: `12px`
    *   Hover: `border-muted-foreground/50`
    *   Selected: `border-primary bg-primary/10`
    *   Label: Sans, 14px, font-medium, $text-primary
    *   Description: Sans, 12px, $text-secondary, margin-top 4px

**Other Input:**
*   Label: "Other:" in $text-secondary
*   Text input field: Standard input styling
*   Margin-top: `8px`

**Buttons:**
*   Compact sizing: `px-2.5 py-1`, font 12px
*   Right-aligned, `8px` gap
1. **Skip** (outlined)
   *   Keyboard: `Esc`
2. **Submit** (primary, disabled until selection made)
   *   Keyboard: `⏎`

**Input Section When Question Pending:**
*   Placeholder: "Waiting for answer..."
*   Input and buttons: disabled with `opacity-50`
*   Cursor: `not-allowed`

**Keyboard Shortcuts:**
*   `Escape` → Skip (dismiss without answering)
*   `Enter` → Submit answer (when valid selection)
*   Shortcuts are handled at window level when question is pending

**Answer Flow:**
1. User selects option(s) or types "Other" text
2. User clicks "Submit" or presses Enter
3. Frontend sends answer via WebSocket as tool_result response
4. Question section animates out (slide-down-fade)
5. Input section re-enables

#### TodoList Panel
Task tracking panel, can be inline or sidebar.

**Container:**
*   Border: `1px solid $border-light`
*   Border-radius: `6px`
*   Background: `$bg-canvas` or `$bg-subtle`
*   Padding: `12px`

**Header:**
*   Text: "Tasks (2/5 complete)" - Mono, Medium, $text-secondary
*   Collapsible caret icon

**Task Items:**
*   Layout: Flex row
*   Status icon (left):
    *   ○ Pending (gray outline circle)
    *   ◐ In Progress (half-filled circle, accent color)
    *   ● Completed (filled circle, green/success color)
*   Task text: Body text, $text-primary
*   Current task indicator: Subtle arrow or highlight
*   Spacing: `8px` between tasks

**Progress Bar:**
*   Height: `4px`
*   Background: `$bg-code-block`
*   Fill: Accent/primary color
*   Position: Bottom of header or top of panel

#### Chat Input Component
Minimal, clean input field for user messages. Designed to be unobtrusive and content-first.

**Container:**
*   Width: Matches message container (`max-w-3xl mx-auto`)
*   Background: `$bg-canvas` (white)
*   Padding: `24px` horizontal (to align with messages)
*   Bottom padding: `16px`
*   No top border or separator (seamless with content)

**Input Card:**
*   Layout: **2-row vertical layout**
*   Border: `1px solid #E5E7EB` ($border-light)
*   Border-radius: `12px` (rounded corners, not pill-shaped)
*   Background: `#FFFFFF` (white)
*   Padding: `16px` internal

**Row 1 - Text Input:**
*   Full width text input field
*   No border, no background (transparent)
*   Font: Sans-serif, 15-16px, $text-primary
*   Placeholder: "Reply..." in $text-secondary (`#9CA3AF`)
*   Min-height: `24px`
*   Focus state: No visible outline (focus handled by container)
*   Multi-line capable (textarea)

**Row 2 - Action Row:**
*   Margin-top: `12px` from input field
*   Flex row: space-between alignment
*   Contains: Attachment icon (left) and Submit button (right)

**Attachment Icon (Bottom-Left):**
*   Icon: Image icon (outlined)
*   Size: `20px`
*   Color: $text-system (`#4A4A4A`)
*   Interactive: Clickable button for file attachment
*   No background, just icon

**Submit Button (Bottom-Right):**
*   Shape: Rounded square button
*   Size: `36px × 36px`
*   Border-radius: `8px`
*   Background: Soft warm beige/pink (`#E5D5C5` or similar)
*   Icon: Arrow up (`↑`)
*   Icon color: Near black (`#1A1A1A`)
*   Icon size: `16px`
*   Disabled state: Lower opacity (40%) when input is empty

**States:**
*   **Empty:** Submit button at 40% opacity
*   **Typing:** Submit button at full opacity, ready to send
*   **Disabled:** Entire input grayed out, not interactive

**No Extra Chrome:**
*   No hint text below input
*   No @ or / buttons (triggered by typing)
*   No visible attachment list (shown inline after selection)
*   Maximum simplicity and focus
*   Clean 2-row layout with clear visual hierarchy

#### Permission Request (Integrated into Chat Input)
When Claude needs permission to use a tool, the input card "grows upward" to include an approval section.

**Design Philosophy:**
*   Permission UI is integrated directly into the chat input card
*   Input card expands to accommodate the permission content
*   A subtle border separates permission section from input section
*   Creates a cohesive, unified experience rather than a disruptive modal

**Layout:**
```
┌──────────────────────────────────────────┐
│ Permission Section                       │
│   Allow Claude to Run {preview}?         │
│   [description if available]             │
│   ┌────────────────────────────────────┐ │
│   │ command preview (code block)       │ │
│   └────────────────────────────────────┘ │
│   [Deny Esc] [Always allow ⌘⏎] [Allow ⏎]│
├──────────────────────────────────────────┤
│ Input Section (dimmed/disabled)          │
│   Waiting for permission...              │
│   [📎]                            [↑]    │
└──────────────────────────────────────────┘
```

**Permission Section:**
*   Padding: `12px`
*   Border-bottom: `1px solid $border-light` (separates from input)

**Header Text:**
*   Format: "Allow Claude to **{Action}** {preview}?"
*   Action is bolded (Run, Read, Write, Edit, Fetch, Search, Use)
*   Preview: monospace, 12px, $text-secondary, truncated to 80 chars
*   Font: Sans, 14px, $text-primary

**Description:**
*   Shows tool description if available (from `input.description`)
*   Font: Sans, 12px, $text-secondary

**Command Preview:**
*   Background: `$bg-code-block`
*   Border: `1px solid $border-light`
*   Border-radius: `8px`
*   Padding: `8px`
*   Font: Monospace, 12px
*   Max-height: `128px` with overflow-y auto
*   Margin-bottom: `12px`

**Buttons:**
*   Compact sizing: `px-2.5 py-1`, font 12px
*   Right-aligned, `8px` gap
1. **Deny** (outlined)
   *   Keyboard: `Esc`
2. **Always allow** (muted background)
   *   Keyboard: `⌘⏎`
3. **Allow once** (primary)
   *   Keyboard: `⏎`

**Input Section When Permission Pending:**
*   Placeholder: "Waiting for permission..."
*   Input and buttons: disabled with `opacity-50`
*   Cursor: `not-allowed`

**Keyboard Shortcuts:**
*   `Escape` → Deny
*   `Enter` → Allow once
*   `Cmd/Ctrl+Enter` → Always allow for session
*   Shortcuts are handled at window level when permission is pending

**"Always Allow" Implementation:**
When user clicks "Always allow", the backend remembers the tool name for the session:
1. Frontend sends `control_response` with `always_allow: true` and `tool_name`
2. Backend adds tool to `Session.alwaysAllowedTools` map
3. Future permission requests for that tool auto-allow without prompting
4. Map clears when session ends (not persisted)

---

## 5. Interaction Patterns & "Feel" Guidelines

### Streaming Dynamics
The UI is not static and must handle real-time content generation.

1.  **Progressive Rendering:** The UI must handle data streaming. Diffs shouldn't "pop" in all at once; they should flow progressively.
2.  **The Cursor:** While the "block" is being generated, a blinking block cursor (`█`) appears at the end of the text stream.
3.  **Scroll Lock:** The view should auto-scroll to keep the cursor visible, unless the user manually scrolls up. Auto-scroll should pause if user scrolls up to review content.

### Visual Density & Spacing Rules
1.  **Paragraph Spacing:** Use `16px` vertical rhythm between text paragraphs.
2.  **List Indentation:** Use `24px` left indentation for nested lists or "thinking" blocks.
3.  **Code Block Padding:** `16px` internal padding for code blocks.
4.  **Inline Code Margin:** `4px` vertical margin for inline code snippets.
5.  **Section Spacing:** `12px` margin-top for major section transitions (e.g., before diff containers).

### Collapsible Content Patterns

Large content blocks should not dominate the screen. We use two standard patterns for collapsible content:

---

#### Pattern: `collapsible-header`

**Slug:** `collapsible-header`

**Use when:** Content is secondary/optional and should be hidden by default. User clicks header to reveal.

**Used by:** Thinking blocks, WebFetch tool, compact summaries

**Behavior:**
- **Collapsed by default** (`useState(false)`)
- Click **entire header row** to toggle
- Chevron indicator: `▸` (collapsed) / `▾` (expanded)
- No banner or button - toggle is via header click

**Visual Pattern:**
```
● Header text ▸                    [collapsed]

● Header text ▾                    [expanded]
  ┌─────────────────────────────┐
  │ Content (markdown/text)     │
  │ maxHeight: 60vh, scrollable │
  └─────────────────────────────┘
```

**Implementation:**
```tsx
function CollapsibleHeader({ title, children }) {
  const [isExpanded, setIsExpanded] = useState(false)

  return (
    <div>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 w-full text-left hover:opacity-80"
      >
        <MessageDot status="..." />
        <span>{title}</span>
        <span className="text-[11px] text-tertiary">
          {isExpanded ? '▾' : '▸'}
        </span>
      </button>

      {isExpanded && (
        <div
          className="mt-2 ml-5 p-4 rounded-md overflow-y-auto"
          style={{ backgroundColor: 'var(--claude-bg-code-block)', maxHeight: '60vh' }}
        >
          {children}
        </div>
      )}
    </div>
  )
}
```

**Key specs:**
- Chevron: `text-[11px]`, `text-tertiary`
- Expanded content: `mt-2 ml-5 p-4 rounded-md`
- Max height: `60vh` with `overflow-y-auto`
- Background: `var(--claude-bg-code-block)`

---

#### Pattern: `expandable-content`

**Slug:** `expandable-content`

**Use when:** Content is important but may be long. Shows preview with option to expand.

**Used by:** Edit tool (diffs), Bash tool (output), compact summaries with preview

**Behavior:**
- **Shows truncated preview** by default (e.g., 5 lines)
- Click **"Show more" / "Show less" button** at bottom to toggle
- Button spans full width of container

**Visual Pattern:**
```
┌─────────────────────────────┐
│ Line 1                      │
│ Line 2                      │
│ Line 3 (truncated)          │
├─────────────────────────────┤
│        Show more            │  [button]
└─────────────────────────────┘

┌─────────────────────────────┐
│ Line 1                      │
│ Line 2                      │
│ Line 3                      │
│ Line 4                      │
│ ... (all content)           │
│ maxHeight: 60vh, scrollable │
├─────────────────────────────┤
│        Show less            │  [button]
└─────────────────────────────┘
```

**Implementation:**
```tsx
const MAX_LINES = 5

function ExpandableContent({ content }) {
  const [expanded, setExpanded] = useState(false)

  const lines = content.split('\n')
  const isTruncated = lines.length > MAX_LINES
  const displayLines = expanded ? lines : lines.slice(0, MAX_LINES)

  return (
    <div className="rounded-md overflow-hidden border border-light">
      <div
        className={expanded && isTruncated ? 'overflow-y-auto' : ''}
        style={expanded && isTruncated ? { maxHeight: '60vh' } : {}}
      >
        {/* Content here */}
      </div>

      {isTruncated && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full py-1.5 text-[12px] hover:opacity-80"
          style={{
            backgroundColor: 'var(--claude-bg-secondary)',
            color: 'var(--claude-text-secondary)',
            borderTop: '1px solid var(--claude-border-light)',
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
```

**Key specs:**
- Default truncation: 5 lines (configurable per component)
- Button: `w-full py-1.5 text-[12px]`
- Button background: `var(--claude-bg-secondary)`
- Button text: `var(--claude-text-secondary)`
- Button border: `borderTop: 1px solid var(--claude-border-light)`
- Expanded max height: `60vh` with `overflow-y-auto`

---

#### Pattern: `gradient-fade`

**Slug:** `gradient-fade`

**Use when:** Content is in a solid-background container (like user message bubbles) where a border separator would look harsh.

**Used by:** User message blocks

**Behavior:**
- **Shows truncated preview** by default (e.g., 10 lines or 500 chars)
- **Gradient overlay** fades content at bottom when truncated
- Click **"Show more"** button floating on gradient to expand
- Click **"Show less"** button (no gradient) to collapse

**Visual Pattern:**
```
┌─────────────────────────────┐
│ Line 1                      │
│ Line 2                      │
│ Line 3 (fading out...)      │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  [gradient overlay]
│        Show more            │  [button on gradient]
└─────────────────────────────┘

┌─────────────────────────────┐
│ Line 1                      │
│ Line 2                      │
│ Line 3                      │
│ Line 4                      │
│ ... (all content)           │
│ maxHeight: 60vh, scrollable │
│        Show less            │  [button, no gradient]
└─────────────────────────────┘
```

**Implementation:**
```tsx
const MAX_LINES = 10
const MAX_CHARS = 500

function GradientFadeContent({ content, bgColor }) {
  const [expanded, setExpanded] = useState(false)

  const lines = content.split('\n')
  const exceedsLines = lines.length > MAX_LINES
  const exceedsChars = content.length > MAX_CHARS
  const isTruncated = exceedsLines || exceedsChars

  let displayContent = content
  if (!expanded && isTruncated) {
    let truncated = lines.slice(0, MAX_LINES).join('\n')
    if (truncated.length > MAX_CHARS) {
      truncated = truncated.slice(0, MAX_CHARS) + '...'
    }
    displayContent = truncated
  }

  return (
    <div className="relative">
      <div
        className={expanded && isTruncated ? 'overflow-y-auto' : ''}
        style={expanded && isTruncated ? { maxHeight: '60vh' } : {}}
      >
        {displayContent}
      </div>

      {/* Gradient fade + Show more button when truncated */}
      {isTruncated && !expanded && (
        <div
          className="absolute bottom-0 left-0 right-0 flex items-end justify-center pb-2 pt-8"
          style={{
            background: `linear-gradient(to bottom, transparent, ${bgColor} 60%)`,
          }}
        >
          <button
            onClick={() => setExpanded(true)}
            className="text-[12px] hover:opacity-80"
            style={{ color: 'var(--claude-text-secondary)' }}
          >
            Show more
          </button>
        </div>
      )}

      {/* Show less button when expanded */}
      {isTruncated && expanded && (
        <div className="flex justify-center pb-2">
          <button
            onClick={() => setExpanded(false)}
            className="text-[12px] hover:opacity-80"
            style={{ color: 'var(--claude-text-secondary)' }}
          >
            Show less
          </button>
        </div>
      )}
    </div>
  )
}
```

**Key specs:**
- Default truncation: 10 lines OR 500 chars (whichever hits first)
- Gradient: `linear-gradient(to bottom, transparent, ${bgColor} 60%)`
- Gradient padding: `pb-2 pt-8` (short bottom, tall top for fade effect)
- Button: Centered, `text-[12px]`, `var(--claude-text-secondary)`
- No border or background on button (floats on gradient)
- Expanded max height: `60vh` with `overflow-y-auto`

---

#### Pattern Comparison

| Aspect | `collapsible-header` | `expandable-content` | `gradient-fade` |
|--------|---------------------|---------------------|-----------------|
| Default state | Hidden | Shows preview | Shows preview |
| Toggle mechanism | Click header | Click banner button | Click floating button |
| Chevron | Yes (`▸`/`▾`) | No | No |
| Banner button | No | Yes (bordered) | Yes (on gradient) |
| Visual separator | None | Border line | Gradient overlay |
| Use case | Secondary content | Bordered containers | Solid-bg containers |

### Iconography
*   **Style:** Line/Stroke icons with `1.5px` stroke width (thin, clean aesthetic)
*   **Size:** `16px` for inline icons, `12px` for status indicators
*   **Recommended Set:** **Lucide React** or **Heroicons (Outline)**
*   **Status Indicators:**
    *   🔴 `12px` circle for "Critical Security Issues" (Red)
    *   🟠 `12px` circle for "Memory & Resource Leaks" (Orange)
    *   🟡 `12px` circle for "Performance Issues" (Yellow)
    *   Use emojis directly in the text flow as status bullets for visual clarity

---

## 6. Implementation Guide for Frontend Engineering

### 6.1 Tool-Specific Visualizations

Each tool type has a specific visualization pattern in the official UI:

| Tool | Visualization Pattern |
|------|----------------------|
| **Read** | File path header (mono, gray) + syntax-highlighted content with line numbers |
| **Write** | File path with "Created" or "Modified" badge + collapsed content preview |
| **Edit** | Side-by-side or unified diff view with file path header (see component E) |
| **Bash** | Terminal-style output: command line + streaming output in monospace, dark-on-light |
| **Glob** | File list with file type icons, grouped by directory, monospace paths |
| **Grep** | Matched files list OR content with line numbers and search term highlighted |
| **WebFetch** | URL (truncated) + collapsible markdown content (click to expand) |
| **WebSearch** | Search query + collapsible link list (click header to expand, shows clickable links) |
| **Task** | Agent name + type badge + status indicator + collapsible output |
| **AskUserQuestion** | Input-integrated question card (see Section 4.G) - pops up above input like permissions |
| **TodoWrite** | Task list panel update (see component G) |
| **Skill** | Skill name + `collapsible-header` pattern showing skill prompt content |

**Common Tool Block Structure:**

All tool blocks follow this unified design pattern based on the official Claude Code UI:

```
● Tool Name parameter_preview
└ Summary or result
└ Additional metadata (duration, status, etc.)
```

**Tool Grouping (Multiple Consecutive Calls):**

When multiple tool calls of the same type occur consecutively, they are grouped with a collapsible header:

```
∨ Read 2 files

  ● Read /home/user/my-life-db/backend/fs/metadata.go
  └ Read 147 lines

  ● Read /home/user/my-life-db/backend/fs/service.go
  └ Read 163 lines
```

**Grouping Rules:**
- **Only consecutive calls** of the same tool type are grouped
- Group header uses caret: `∨` (expanded) or `>` (collapsed)
- Header text: `{ToolName} {count} file{s}` (e.g., "Read 2 files")
- Header color: `var(--claude-text-secondary)` (gray)
- Individual tools are indented 24px (`ml-6` in Tailwind)
- Single tool calls are NOT grouped (render directly)
- Mixed tool types break the group

**Example (No Grouping - Mixed Types):**
```
● Read file.go
└ Read 100 lines

● Bash ls -la
└ exit 0

● Read another.go  ← Different Read, not consecutive
└ Read 50 lines
```

**Design Specifications:**

1. **Header Line (Individual Tool):**
   - Status-colored bullet indicator:
     - 🟢 Green `●` (`#22C55E`) - Success/completed
     - 🔴 Red `●` (`#D92D20`) - Failed/error
     - 🟡 Orange `●` (`#F59E0B`) - Running/permission required
     - ⚪ Gray `○` (`#9CA3AF`) - Pending (outline)
   - Tool name in bold/semi-bold
   - Parameters in gray monospace text
   - All on single line, no background boxes

2. **Output Lines (L-shaped indent):**
   - Use `└` character for visual hierarchy
   - Monospace 13px font
   - Secondary/tertiary gray colors
   - No borders or containers

3. **Color Palette:**
   - Bullet: Status-dependent (see above)
   - Tool name: `var(--claude-text-primary)` (near black)
   - Parameters: `var(--claude-text-secondary)` (cool gray `#5F6368`)
   - Output: `var(--claude-text-secondary)` or `var(--claude-text-tertiary)`
   - Errors: `var(--claude-status-alert)` (red)

**Specific Tool Implementations:**

<details>
<summary><strong>Read Tool - Detailed Spec</strong></summary>

**Collapsed State:**
```
● Read /path/to/file.tsx
└ Read 316 lines
```

**Layout:**
```tsx
<div className="font-mono text-[13px] leading-[1.5]">
  <div className="flex items-start gap-2">
    <span className="text-[#22C55E]">●</span>
    <span className="font-semibold text-primary">Read</span>
    <span className="text-secondary">/path/to/file.tsx</span>
  </div>
  <div className="mt-1 flex gap-2 text-secondary">
    <span>└</span>
    <span>Read 316 lines</span>
  </div>
</div>
```

**Key Features:**
- No code block container in collapsed state
- Clean summary with line count
- Green bullet indicates successful read
- L-shaped indent for output summary

</details>

<details>
<summary><strong>Bash Tool - Detailed Spec</strong></summary>

**Collapsed State:**
```
● Bash git log --oneline -3
└ 91e3760 feat: add debug endpoint
  f4ec671 fix: route SaveRawFile through fs.Service
  6cdfe90 fix: address Claude Code production readiness
```

**Layout:**
```tsx
<div className="font-mono text-[13px] leading-[1.5]">
  <div className="flex items-start gap-2">
    <span className="text-[#22C55E]">●</span>
    <span className="font-semibold text-primary">Bash</span>
    <span className="text-secondary">git log --oneline -3</span>
  </div>
  <div className="mt-1 flex gap-2 text-secondary">
    <span>└</span>
    <pre className="whitespace-pre-wrap">{output}</pre>
  </div>
  {/* Optional status */}
  <div className="mt-1 flex gap-2 text-tertiary">
    <span>└</span>
    <div>
      <span className="text-success">exit 0</span>
      <span>⏱ 0.24s</span>
    </div>
  </div>
</div>
```

**Key Features:**
- NO dark terminal background (uses light theme)
- Command and output in bordered container with rounded corners
- Command section has `bg-secondary` background
- Output section separated by `borderTop`
- Success = green exit code, failure = red

**Truncation:** Uses [`expandable-content`](#pattern-expandable-content) pattern
- Limit: **5 lines** for output
- Shows "Show more/less" banner button when truncated

</details>

<details>
<summary><strong>Write Tool - Detailed Spec</strong></summary>

**Pattern:**
```
● Write /path/to/new-file.tsx
└ Created file (42 lines)
```

Or for modifications:
```
● Write /path/to/existing.tsx
└ Modified file (156 lines)
```

</details>

<details>
<summary><strong>Glob Tool - Detailed Spec</strong></summary>

**Pattern:**
```
● Glob **/*.tsx
└ Found 23 files
  frontend/app/components/file-card.tsx
  frontend/app/components/url-crawler.tsx
  ...
```

</details>

<details>
<summary><strong>Grep Tool - Detailed Spec</strong></summary>

**Pattern:**
```
● Grep "useState" --type tsx
└ Found in 8 files
  frontend/app/routes/home.tsx:15
  frontend/app/routes/inbox.tsx:22
  ...
```

</details>

<details>
<summary><strong>WebFetch Tool - Detailed Spec</strong></summary>

**UX Pattern:** [`collapsible-header`](#pattern-collapsible-header)

**Visual:**
```
● WebFetch https://example.com/very/long/path/to/page... ▸   [collapsed]
└ 200 OK (12.5KB, 234ms)

● WebFetch https://example.com/very/long/path/to/page... ▾   [expanded]
└ 200 OK (12.5KB, 234ms)
  ┌─────────────────────────────────────────┐
  │ # Page Title                            │
  │ Content rendered as markdown...         │
  └─────────────────────────────────────────┘
```

**Key Features:**
- Uses `collapsible-header` pattern (collapsed by default, click header to expand)
- URL displayed in **single line** with `truncate` (ellipsis if too long)
- Summary line shows HTTP status code, response size, and duration
- Content rendered as **markdown** when expanded

**toolUseResult Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `bytes` | number | Response size in bytes |
| `code` | number | HTTP status code |
| `codeText` | string | HTTP status text (e.g., "OK") |
| `result` | string | Extracted/summarized content (markdown) |
| `durationMs` | number | Request duration in milliseconds |
| `url` | string | Final URL (may differ from request URL after redirects) |

</details>

<details>
<summary><strong>WebSearch Tool - Detailed Spec</strong></summary>

**UX Pattern:** [`collapsible-header`](#pattern-collapsible-header)

**Visual:**
```
● WebSearch "gold price January 2026" ▸                    [collapsed]
└ Found 10 results (17.9s)

● WebSearch "gold price January 2026" ▾                    [expanded]
└ Found 10 results (17.9s)
  ┌─────────────────────────────────────────┐
  │ Today's Gold Prices: January 26, 2026   │
  │ https://money.com/gold-prices-today...  │
  │                                         │
  │ Current price of gold as of January 26  │
  │ https://fortune.com/article/current...  │
  │                                         │
  │ Gold - Price - Chart - Historical Data  │
  │ https://tradingeconomics.com/commodity. │
  └─────────────────────────────────────────┘
```

**Key Features:**
- Uses `collapsible-header` pattern (collapsed by default, click header to expand)
- Query displayed after tool name
- Summary shows result count and duration
- When expanded, shows clickable links with titles and URLs
- Links open in new tab (`target="_blank"`)

**toolUseResult Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `query` | string | The search query that was executed |
| `results` | array | Heterogeneous array: `[LinksContainer, FormattedString]` |
| `results[0].tool_use_id` | string | Server-side tool use ID |
| `results[0].content` | array | Array of link objects with `title` and `url` |
| `results[1]` | string | Formatted search results with summaries |
| `durationSeconds` | number | Search duration in seconds |

</details>

<details>
<summary><strong>Task Tool - Detailed Spec</strong></summary>

The Task tool spawns a subagent and has a **special lifecycle** with progress messages. See [data-models.md Section 4h](./data-models.md#4h-task-tool-lifecycle) for the complete message flow.

**Lifecycle:**
```
1. Assistant message with Task tool_use
2. 0 or more agent_progress messages (progress type)
3. Exactly 1 tool_result (user message)
```

**Tool Use (Pending):**
```
○ Task Explore frontend Claude integration
└ Spawning agent...
```

**With Progress (Running):**
```
● Task Explore frontend Claude integration
└ Agent aa6fc0e working...
  └ Explore the current Claude Code integration in `backend/claude/`...
```

**Completed:**
```
● Task Explore frontend Claude integration
└ Agent aa6fc0e completed (51.4s, 67558 tokens, 24 tool calls)
```

**Layout:**
```tsx
<div className="font-mono text-[13px] leading-[1.5]">
  <div className="flex items-start gap-2">
    <span className="text-[#22C55E]">●</span>
    <span className="font-semibold text-primary">Task</span>
    <span className="text-secondary">{description}</span>
  </div>
  {/* Agent progress indicator */}
  <div className="mt-1 flex gap-2 text-secondary">
    <span>└</span>
    <span>Agent {agentId} {status}...</span>
  </div>
  {/* Nested agent prompt (collapsible) */}
  {expanded && (
    <div className="ml-4 mt-1 flex gap-2 text-tertiary">
      <span>└</span>
      <span className="whitespace-pre-wrap">{prompt}</span>
    </div>
  )}
</div>
```

**Key Differences from Other Tools:**
- Can have **multiple progress messages** before result
- Progress uses `parentUuid` to link back to Task tool_use message
- Result includes agent stats (duration, tokens, tool calls)
- `agentId` is a 7-character hex identifier

**Subagent Message Handling:**

The Task tool spawns a subagent whose messages have `parent_tool_use_id` pointing back to the Task's `tool_use.id`. See [data-models.md "Subagent Message Hierarchy"](./data-models.md#subagent-message-hierarchy--critical) for full details.

**Filtering Criteria:**
```typescript
// Filter subagent messages from top-level rendering
const isSubagentMessage = (msg) => msg.parent_tool_use_id != null

// Group by parent Task for nested rendering
const subagentMessagesMap = buildSubagentMessagesMap(messages)
```

**Rendering:**
```
● Task "Review FS architecture" (Explore) ▾
  ┌─────────────────────────────────────────┐
  │ [Result markdown - final answer]        │
  └─────────────────────────────────────────┘
  ▸ Sub-agent conversation (24 messages)    [collapsed by default]
    ┌───────────────────────────────────────┐
    │ Nested SessionMessages with depth+1   │
    │ - user: prompt to subagent            │
    │ - assistant: tool_use Read            │
    │ - user: tool_result                   │
    │ - ...                                 │
    └───────────────────────────────────────┘
```

**Data Sources:**
| Source | When | Use Case |
|--------|------|----------|
| `agent_progress.data.normalizedMessages` | Live streaming | Real-time progress |
| Messages with `parent_tool_use_id` | Always (persisted) | Historical sessions, full conversation |

</details>

<details>
<summary><strong>Skill Tool - Detailed Spec</strong></summary>

**UX Pattern:** [`collapsible-header`](#pattern-collapsible-header)

**Visual:**
```
● Skill superpowers:systematic-debugging ▸   [collapsed]
└ Loaded skill

● Skill superpowers:systematic-debugging ▾   [expanded]
└ Loaded skill
  ┌─────────────────────────────────────────┐
  │ # Systematic Debugging                  │
  │                                         │
  │ ## Overview                             │
  │ Random fixes waste time...              │
  └─────────────────────────────────────────┘
```

**Key Features:**
- Uses `collapsible-header` pattern (collapsed by default, click header to expand)
- Skill name displayed after "Skill" in header
- Summary line shows "Loaded skill"
- Content is fetched from associated `isMeta` message via `sourceToolUseID`
- Content rendered as **markdown** when expanded

**Message Flow:**

The Skill tool has a unique message pattern:
1. **tool_use** - Assistant calls Skill tool with `skill` parameter
2. **tool_result** - User message with success confirmation
3. **isMeta message** - User message with `isMeta: true` and `sourceToolUseID` containing the full skill prompt

The skill content is mapped via `skillContentMap` which links `sourceToolUseID` to the skill prompt text from the `isMeta` message.

**Layout:**
```tsx
<div className="font-mono text-[13px] leading-[1.5]">
  <div className="flex items-start gap-2">
    <span className="text-[#22C55E]">●</span>
    <span className="font-semibold text-primary">Skill</span>
    <span className="text-secondary">{skillName}</span>
    <span className="text-tertiary text-[11px]">▸</span>
  </div>
  <div className="mt-1 flex gap-2 text-secondary">
    <span>└</span>
    <span>Loaded skill</span>
  </div>
  {/* Expanded: markdown-rendered skill content */}
</div>
```

</details>

**Anti-Patterns (DO NOT DO):**

❌ Dark terminal backgrounds for Bash output
❌ Code block containers around tool output
❌ Colored bubbles or heavy chrome
❌ Multi-line headers with parameters on separate lines
❌ Missing green bullet indicators
❌ Using `>` or `▶` instead of `●` for tool headers

### 6.2 Session-Level Messages

These are top-level session events that are rendered as simple status indicators (not as chat bubbles or tool calls).

| Message Type | Display | Description |
|--------------|---------|-------------|
| `system.subtype: compact_boundary` | "Session compacted" | Marks where conversation was compacted to reduce context |
| `system.subtype: microcompact_boundary` | "Context microcompacted" + collapsible tool list | Marks where specific tool outputs were compacted, shows which tools and tokens saved |
| `system.subtype: init` | System init block | Shows session initialization with tools, model, MCP servers |
| `system.subtype: turn_duration` | "Turn completed in Xm Ys" | Turn duration telemetry showing how long a turn took |
| `system.subtype: hook_started` | "Hook {status}: {hook_name}" + collapsible output | Hook execution (paired with hook_response via hookResponseMap) |
| `user.isCompactSummary: true` | "Session continued" + collapsible summary | User message containing the compacted conversation summary |
| `type: summary` | "Session summary" + summary text | Auto-generated session summary (created when session index is rebuilt) |

**Summary Message Rendering:**

```
● Session summary
  Claude SDK UI Mode Integration Complete
```

The `summary` message displays the auto-generated session title. This is different from `compact_boundary` (which marks compaction events) - `summary` is the Claude-generated title stored in the JSONL file.

### 6.3 Skipped Message Types

Some message types are intentionally **not rendered** in the chat interface as standalone messages. These are internal/metadata messages that provide no user-facing value when displayed directly.

**Skipped Types:**

| Type / Field | Reason |
|--------------|--------|
| `file-history-snapshot` | Internal file versioning metadata for undo/redo |
| `queue-operation` | Internal session queue management (enqueue/dequeue events at session start) |
| `type: "result"` | Turn terminator (stdout only, not persisted). Contains summary stats. Used for state derivation, not display. |
| `isMeta: true` | System-injected context messages (e.g., `<local-command-caveat>`) not meant for display |
| Skipped XML tags only | User messages containing ONLY skipped XML tags (no other content) |
| `type: "progress"` | Progress messages are rendered inside their parent tools, not as standalone messages |
| `system.subtype: hook_response` | Rendered inside hook_started via hookResponseMap, not as standalone message |
| `system.subtype: status` | Rendered as **transient indicator** at end of message list when non-null (e.g., "Compacting..."). Disappears when status is null. |
| `type: "control_request"` | Permission protocol message - triggers permission modal, not a chat message |
| `type: "control_response"` | Permission protocol message - sent from UI to CLI via stdin, not displayed |
| `parent_tool_use_id` set | Subagent messages - rendered inside parent Task tool, not as top-level messages. See [data-models.md "Subagent Message Hierarchy"](./data-models.md#subagent-message-hierarchy--critical). |

**Progress Messages:**

Progress messages (`type: "progress"`) are filtered from the main message list but are rendered **inside their parent tool components**:

| `data.type` | Rendered Inside | Description |
|-------------|----------------|-------------|
| `agent_progress` | Task tool | Subagent spawning and execution progress |
| `bash_progress` | Bash tool | Long-running command elapsed time and output |
| `hook_progress` | Tool with hook | Hook execution progress (PostToolUse hooks running after tool completes) |
| `query_update` | (future) | Web search query being executed |
| `search_results_received` | (future) | Web search results received |

Progress messages are linked to their parent tool via `parentToolUseID`, which maps to the `tool_use` block's `id` field.

**Subagent Messages:**

When a Task tool spawns a subagent, the subagent's conversation messages (user prompts, assistant tool calls, tool results) have `parent_tool_use_id` set to the Task's `tool_use.id`. These messages are:

1. **Filtered from top-level** - They should not appear as standalone messages in the main chat
2. **Grouped by parent** - Build a `subagentMessagesMap` keyed by `parent_tool_use_id`
3. **Rendered inside Task tool** - The Task tool component renders them in a collapsible "Sub-agent conversation" section

```typescript
// Filter subagent messages from main message list
const topLevelMessages = messages.filter(m => !m.parent_tool_use_id)

// Group for Task tool rendering
const subagentMessagesMap = new Map<string, SessionMessage[]>()
for (const msg of messages) {
  if (msg.parent_tool_use_id) {
    const existing = subagentMessagesMap.get(msg.parent_tool_use_id) || []
    existing.push(msg)
    subagentMessagesMap.set(msg.parent_tool_use_id, existing)
  }
}
```

See [data-models.md "Subagent Message Hierarchy"](./data-models.md#subagent-message-hierarchy--critical) for full details on message structure and examples.

**Skipped XML Tags:**

User messages are skipped if their content consists **entirely** of these XML tags (whitespace allowed between tags, but no other content):

| Tag | Description |
|-----|-------------|
| `<command-name>` | Local slash command name (e.g., `/clear`, `/doctor`) |
| `<command-message>` | Local command message text |
| `<command-args>` | Local command arguments |
| `<local-command-caveat>` | Caveat about local commands |
| `<local-command-stdout>` | Stdout from local command execution |

> **Design Principle:** All other message types should be rendered. Unknown types are displayed as raw JSON to aid debugging and ensure no messages are silently lost. The XML tag check is **strict**: if ANY tag is not in the skip list, or if there's any non-whitespace content outside the tags, the message is rendered.

**file-history-snapshot Example:**

> **Note**: This message type is not officially documented by Anthropic. The structure below is based on observed behavior.

```json
{
  "type": "file-history-snapshot",
  "messageId": "624209ac-a14f-4345-8515-32cd8b826a2c",
  "snapshot": {
    "messageId": "624209ac-a14f-4345-8515-32cd8b826a2c",
    "trackedFileBackups": {},
    "timestamp": "2026-01-26T04:21:28.776Z"
  },
  "isSnapshotUpdate": false
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"file-history-snapshot"` |
| `messageId` | string | UUID of the associated message |
| `snapshot.messageId` | string | Same as parent messageId |
| `snapshot.trackedFileBackups` | object | Map of file paths to backup info (empty if no files tracked) |
| `snapshot.timestamp` | string | ISO 8601 timestamp of the snapshot |
| `isSnapshotUpdate` | boolean | Whether this updates an existing snapshot |

**Why Skip:** These messages are emitted after file-modifying operations (Edit, Write) to enable undo functionality. They contain no content relevant to the conversation flow and would clutter the UI.

---

**queue-operation Example:**

```json
{
  "type": "queue-operation",
  "operation": "dequeue",
  "timestamp": "2026-01-27T05:45:37.707Z",
  "sessionId": "53c3b596-1080-4f03-bf16-e710760b0131"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"queue-operation"` |
| `operation` | string | Queue operation type: `"enqueue"` or `"dequeue"` |
| `timestamp` | string | ISO 8601 timestamp of the operation |
| `sessionId` | string | Session UUID being queued/dequeued |

**Why Skip:** These messages are internal session queue management events emitted at session start. They indicate when the session is queued for processing and when it's dequeued for execution. This is infrastructure-level metadata that provides no user-facing value.

---

**isMeta Messages:**

Messages with `isMeta: true` are system-injected context that should not be displayed to users. These are typically user-type messages that contain XML tags like `<local-command-caveat>` injected by the CLI.

**isMeta Example:**

```json
{
  "parentUuid": null,
  "isSidechain": false,
  "userType": "external",
  "cwd": "/Users/iloahz/projects/my-life-db",
  "sessionId": "5462bb18-d8af-42df-b41b-f6eb13fbda61",
  "version": "2.1.15",
  "gitBranch": "main",
  "type": "user",
  "message": {
    "role": "user",
    "content": "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>"
  },
  "isMeta": true,
  "uuid": "998fb947-5f37-4d6c-8eb9-6e0504653ef0",
  "timestamp": "2026-01-26T06:42:52.956Z"
}
```

**Key Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `isMeta` | boolean | When `true`, skip rendering this message |
| `type` | string | Usually `"user"` for meta messages |
| `message.content` | string | Contains system XML tags (e.g., `<local-command-caveat>`) |

**Why Skip:** These messages inject context for Claude's benefit (e.g., warnings about local commands) but have no value for the user viewing the conversation. Displaying them would show confusing XML content in the chat.

---

**Skipped XML Tags Messages:**

User messages that consist entirely of skipped XML tags are not rendered. This catches local command echoes that don't have `isMeta: true`.

**Skipped XML Tags Example:**

```json
{
  "parentUuid": "998fb947-5f37-4d6c-8eb9-6e0504653ef0",
  "isSidechain": false,
  "userType": "external",
  "cwd": "/Users/iloahz/projects/my-life-db",
  "sessionId": "5462bb18-d8af-42df-b41b-f6eb13fbda61",
  "version": "2.1.15",
  "gitBranch": "main",
  "type": "user",
  "message": {
    "role": "user",
    "content": "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>"
  },
  "uuid": "83786475-b2c8-46f6-80b4-e747998484bb",
  "timestamp": "2026-01-26T06:42:52.828Z"
}
```

**Detection Logic:**

1. Must be a `user` type message
2. `message.content` must be a string
3. Content must contain at least one XML tag
4. ALL tags must be in the skip list (`command-name`, `command-message`, `command-args`, `local-command-caveat`)
5. Content outside tags must be whitespace only

**Examples:**

| Content | Skipped? | Reason |
|---------|----------|--------|
| `<command-name>/clear</command-name>` | ✅ Yes | All tags in skip list |
| `<command-name>/clear</command-name><command-args></command-args>` | ✅ Yes | All tags in skip list |
| `<command-name>/clear</command-name> hello` | ❌ No | Has non-tag content ("hello") |
| `<unknown-tag>foo</unknown-tag>` | ❌ No | Tag not in skip list |
| `hello world` | ❌ No | No XML tags |

**Why Skip:** These messages echo local slash commands (like `/clear`) that the user ran. The command execution is already shown via other means, and displaying raw XML would clutter the UI.

### 6.4 Data Model

To replicate this effectively, structure the React/Vue components with these TypeScript interfaces:

```typescript
type MessageType = 'user' | 'assistant' | 'system';
type ToolStatus = 'pending' | 'running' | 'completed' | 'failed';

interface DiffHunk {
  originalLineStart: number;
  lines: Array<{
    type: 'add' | 'remove' | 'context';
    content: string;
    lineNumber?: number;
  }>;
}

interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, any>;
  status: ToolStatus;
  result?: any;
  duration?: number;
  isCollapsed?: boolean;
}

interface TodoItem {
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface Question {
  question: string;
  header: string;
  options: Array<{
    label: string;
    description: string;
  }>;
  multiSelect: boolean;
}

interface Block {
  type: 'text' | 'code' | 'diff' | 'tool_call' | 'status_list' | 'question' | 'todo';
  content: string | DiffHunk | ToolCall | Question | TodoItem[];
  metadata?: {
    filePath?: string;
    language?: string;
    severity?: 'critical' | 'warning' | 'info';
  };
}

interface Message {
  id: string;
  role: MessageType;
  blocks: Block[];
  timestamp: Date;
  isStreaming?: boolean;
}

interface ClaudeSession {
  id: string;
  name: string;
  createdAt: Date;
  messages: Message[];
  tokenUsage: {
    used: number;
    limit: number;
  };
  model: string;
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  currentBranch?: string;
}
```

### 6.5 Tailwind CSS Utility Classes

Quick reference for styling with Tailwind:

```tsx
// Container/Wrapper
"max-w-3xl mx-auto px-4 py-8"

// Prose/Markdown Content
"prose prose-slate prose-p:my-2 prose-headings:font-semibold prose-code:font-mono prose-code:bg-gray-100 prose-code:px-1 prose-code:rounded prose-code:before:content-none prose-code:after:content-none"

// Typography
"text-[15px] leading-relaxed text-gray-900 font-sans" // Body text
"font-mono text-[13px] bg-gray-100 px-1 py-0.5 rounded text-gray-800" // Inline code
"font-mono text-xs text-gray-500 flex items-center gap-2 mb-2" // File path header

// Diff Container
"border border-gray-200 rounded-lg overflow-hidden my-4" // Container
"bg-gray-50 border-b border-gray-200 px-3 py-2 text-xs font-mono text-gray-600 font-medium" // Diff header
"bg-[#e6ffec] text-[#22863a] font-mono whitespace-pre" // Added line
"bg-[#ffebe9] text-[#cb2431] font-mono whitespace-pre" // Deleted line
```

### 6.6 Critical Rendering Logic

#### Markdown Parsing
You cannot use a standard Markdown renderer out of the box. Use a custom renderer (e.g., `react-markdown` with custom components) to handle:

1.  **Custom Block Types:** Intercept specific syntax for collapsible tool logs and diffs
2.  **Diff Blocks:** LLMs output diffs in markdown code blocks labeled `diff`. Render these as the "File Edit" component instead of generic code blocks.
3.  **Collapsible Sections:** Support custom syntax like `> Read 3 files` for tool call logs

**Recommended Libraries:**
*   `react-markdown` or `marked` for base parsing
*   Custom component mapping for block types

#### Syntax Highlighting
1.  **Recommended Library:** `Shiki` (or `Prism.js` as alternative)
2.  **Theme:** Use a light, high-contrast theme that matches the design system
3.  **Critical:** Do NOT use dark themes for code blocks in this UI mode
4.  **Integration:** Apply syntax highlighting *on top* of diff background colors
5.  **Performance:** Consider lazy-loading or code-splitting for syntax highlighter

#### Scroll Anchoring & Stick-to-Bottom

The message list uses [`use-stick-to-bottom`](https://github.com/stackblitz-labs/use-stick-to-bottom) — a zero-dependency React hook that uses `ResizeObserver` to detect content size changes and automatically maintain scroll position.

**Configuration:**
```tsx
const { scrollRef, contentRef } = useStickToBottom({
  initial: 'instant',  // No animation on initial load
  resize: 'instant',   // No animation when content resizes
})
```

**Scroll Behaviors:**

1.  **Initial Load:** Scrolls to bottom instantly (before paint) when a session is opened. No visible scrolling animation — the user sees the bottom of the conversation immediately.
2.  **New Messages / Content Changes:** When new messages arrive, images load, sections expand, or any content resizes, the `ResizeObserver` detects the size change and scrolls to bottom instantly — but only if the user is currently at the bottom (sticky).
3.  **User Scrolls Up:** The library detects user-initiated scroll and "escapes from lock" — auto-scrolling stops so the user can read previous messages without being yanked back down.
4.  **User Scrolls Back Down:** When the user scrolls back to the bottom, stickiness automatically resumes and new content will again trigger auto-scroll.

**Why `use-stick-to-bottom` over manual `useLayoutEffect`:**
- `useLayoutEffect` + `scrollTop = scrollHeight` fires after React DOM mutations but before paint — however, if content hasn't fully laid out (images, async content, expanding sections), `scrollHeight` may not be the final value, resulting in "near bottom" but not "at bottom".
- `ResizeObserver` catches *all* content size changes (images loading, collapsible sections expanding, streaming text) and re-scrolls correctly.
- The library correctly distinguishes user scroll from programmatic scroll without debouncing.

**Architecture:**
- `scrollRef` → attached to the outer scrollable container (`overflow-y: auto`)
- `contentRef` → attached to the inner content div that holds all messages
- The hook also exposes `isAtBottom` and `scrollToBottom()` for future use (e.g., a "scroll to bottom" button when the user has scrolled up)

#### Working State Detection (`isWorking`)

The UI needs to determine whether Claude is currently working (processing a request) to show appropriate indicators (spinner, "Working..." text, interrupt button). This state is derived from message history rather than tracked separately, enabling second tabs to correctly detect state.

**Option A: Turn-Based Detection (Current Implementation)**

```typescript
const isWorking = useMemo(() => {
  if (isActive === false) return false      // CLI not running
  if (optimisticMessage) return true         // User just sent message

  // Has a turn started? (real user message exists, not tool_result)
  const hasStartedTurn = rawMessages.some(
    (m) => m.type === 'user' && !hasToolUseResult(m)
  )
  if (!hasStartedTurn) return false          // No turn started = not working

  // Turn started, check if complete
  const lastMsg = rawMessages[rawMessages.length - 1]
  return lastMsg?.type !== 'result'          // Turn not terminated
}, [rawMessages, optimisticMessage, isActive])
```

**Rationale:** Working = a turn is in progress (started but not completed).
- A turn **starts** when user sends a real message (not `tool_result`)
- A turn **ends** when `result` message received

**Reliability:**
- ✅ Live sessions: 100% reliable - `result` always emitted when turn completes
- ✅ Historical sessions: `isActive === false` check returns `false` immediately
- ✅ New session with only hooks: `hasStartedTurn` is `false` → not working
- ✅ Interrupted sessions: Claude emits `result` with `subtype: "error_during_execution"`

The key insight: `result` messages are stdout-only (not persisted to JSONL), but this doesn't matter because historical sessions have `isActive === false`, so we never reach the `result` check.

**Option B: Content Heuristics (Previous Implementation)**

```typescript
export function deriveIsWorking(messages: SessionMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]

    // Skip metadata types (system, progress, result, summary, etc.)
    if (SKIP_MESSAGE_TYPES.has(msg.type)) continue

    // Skip tool result messages (automatic responses)
    if (msg.type === 'user' && hasToolUseResult(msg)) continue

    // Assistant ending with text = finished
    if (msg.type === 'assistant' && msg.message?.content) {
      const lastBlock = msg.message.content[msg.message.content.length - 1]
      if (lastBlock?.type === 'text') return false
      return true  // tool_use or thinking = working
    }

    // User message pending = working
    if (msg.type === 'user') return true
  }
  return false
}
```

**Rationale:** Infers state by inspecting conversation structure - if last assistant message ends with text, Claude is done; if it ends with tool_use, Claude is still executing.

**Reliability:**
- ✅ Historical sessions: Works correctly since it only needs persisted message content
- ⚠️ Heuristic-based: Assumes "text at end = done" which may not hold for all Claude Code behaviors
- ⚠️ Content block inspection: Fragile if message structure changes
- ⚠️ Requires `isActive` check externally (function doesn't know about session state)

**Comparison Table:**

| Scenario | Option A (turn-based) | Option B (heuristics) |
|----------|----------------------|----------------------|
| New session, only hooks | ✅ correct (`hasStartedTurn` guard) | ✅ correct |
| Live session, turn complete | ✅ correct | ✅ correct |
| Live session, mid-turn | ✅ correct | ✅ correct |
| Live session, interrupted | ✅ correct (`result` with `subtype: "error_during_execution"`) | ✅ correct |
| Historical session loaded | ✅ correct (`isActive` guard) | ✅ correct |
| Streaming: text arrived, no result yet | shows "working" (transient) | shows "idle" |
| New/unknown message types | ✅ safe default | ⚠️ may misdetect |

**Current Decision:** Using Option A.

- Both options are reliable for the common cases
- Option A uses explicit signals (`result` message, turn start detection) rather than inferring from content structure
- New sessions with only hook messages correctly show "not working"
- Interrupted sessions work correctly - Claude emits `result` with `subtype: "error_during_execution"` (verified)
- The "streaming text, no result yet" case is transient (milliseconds) and not user-visible
- Option A is more robust to future changes in message structure

### 6.7 Component Structure & Directory Organization

**Recommended Directory Structure:**

```
frontend/app/
├── components/
│   └── claude/
│       ├── ChatInterface.tsx         # Main chat container
│       ├── MessageList.tsx           # Message history display
│       ├── MessageBlock.tsx          # Individual message wrapper
│       ├── BlockRenderer.tsx         # Block type router
│       ├── ChatInput.tsx             # Input with @ and / support
│       ├── SessionHeader.tsx         # Session info bar
│       ├── blocks/
│       │   ├── MarkdownBlock.tsx     # Markdown rendering
│       │   ├── CodeBlock.tsx         # Code with syntax highlighting
│       │   ├── DiffView.tsx          # Unified diff viewer
│       │   ├── ToolLog.tsx           # Collapsible tool invocation
│       │   ├── StatusList.tsx        # Issue/status list
│       │   ├── QuestionBlock.tsx     # AskUserQuestion
│       │   └── TodoPanel.tsx         # TodoWrite visualization
│       ├── tools/
│       │   ├── ReadTool.tsx          # Read tool visualization
│       │   ├── WriteTool.tsx         # Write tool visualization
│       │   ├── EditTool.tsx          # Edit tool with diff
│       │   ├── BashTool.tsx          # Terminal-style output
│       │   ├── GlobTool.tsx          # File list display
│       │   ├── GrepTool.tsx          # Search results
│       │   ├── WebFetchTool.tsx      # Web content display
│       │   └── WebSearchTool.tsx     # Search results links
│       ├── modals/
│       │   ├── PermissionModal.tsx   # Permission request modal
│       │   └── SettingsModal.tsx     # Settings configuration
│       └── ui/
│           ├── StreamingCursor.tsx   # Blinking cursor component
│           ├── ToolBlock.tsx         # Generic tool wrapper
│           └── CollapsibleSection.tsx # Reusable collapsible
├── hooks/
│   ├── useClaude.ts                  # Claude API integration
│   ├── useClaudeSession.ts           # Session management
│   ├── useStreamingResponse.ts       # SSE/WebSocket streaming
│   └── useToolExecution.ts           # Tool state management
├── contexts/
│   └── ClaudeContext.tsx             # Global Claude state
├── routes/
│   └── claude.tsx                    # Claude Code page route
└── types/
    └── claude.ts                     # TypeScript types
```

**Component Structure Example:**

```tsx
// Top-level message stream
<MessageStream>
  {messages.map(msg => (
    <MessageBlock key={msg.id} type={msg.type}>
      {msg.blocks.map(block => (
        <BlockRenderer block={block} />
      ))}
      {msg.isStreaming && <Cursor />}
    </MessageBlock>
  ))}
</MessageStream>

// Block renderer with type discrimination
function BlockRenderer({ block }: { block: Block }) {
  switch (block.type) {
    case 'text':
      return <MarkdownBlock content={block.content} />;
    case 'code':
      return <CodeBlock content={block.content} language={block.metadata?.language} />;
    case 'diff':
      return <DiffView diff={block.content} filePath={block.metadata?.filePath} />;
    case 'tool_call':
      return <ToolLog content={block.content} isCollapsed={block.isCollapsed} />;
    case 'status_list':
      return <StatusList items={block.content} severity={block.metadata?.severity} />;
  }
}
```

### 6.8 Backend Integration & Communication Protocol

**API Endpoints Required:**

```typescript
// Session Management
GET    /api/claude/sessions              // List all sessions
POST   /api/claude/sessions              // Create new session
GET    /api/claude/sessions/:id          // Get session details
DELETE /api/claude/sessions/:id          // Delete session
PUT    /api/claude/sessions/:id/name     // Rename session

// Messaging (SSE/WebSocket)
POST   /api/claude/sessions/:id/messages // Send message, get streaming response
GET    /api/claude/sessions/:id/stream   // SSE endpoint for streaming

// Tool Execution
POST   /api/claude/tools/:name/approve   // Approve tool execution
POST   /api/claude/tools/:name/deny      // Deny tool execution

// Context & State
GET    /api/claude/sessions/:id/context  // Get context usage
POST   /api/claude/sessions/:id/compact  // Trigger compaction

// Permissions
GET    /api/claude/permissions           // Get permission settings
PUT    /api/claude/permissions/mode      // Update permission mode
```

**Message Protocol (Streaming):**

The backend should stream messages using SSE or WebSocket with JSON payloads:

```typescript
// Text delta (streaming response)
{
  "type": "content_delta",
  "delta": "partial text...",
  "messageId": "msg_123"
}

// Tool use request
{
  "type": "tool_use",
  "toolCall": {
    "id": "tool_456",
    "name": "bash",
    "parameters": { "command": "ls -la" }
  },
  "requiresApproval": true
}

// Tool result
{
  "type": "tool_result",
  "toolCallId": "tool_456",
  "result": "...",
  "duration": 1234
}

// Question from Claude
{
  "type": "ask_user_question",
  "question": {...}
}

// Todo update
{
  "type": "todo_update",
  "todos": [...]
}

// Message complete
{
  "type": "message_complete",
  "messageId": "msg_123",
  "tokenUsage": { "input": 100, "output": 200 }
}
```

### 6.9 Accessibility Considerations

*   **Keyboard Navigation:** Ensure collapsible sections are keyboard-accessible (Enter/Space to toggle)
*   **Screen Readers:** Use semantic HTML (`<details>`, `<summary>` for collapsible content)
*   **Color Contrast:** All text must meet WCAG AA standards (diff colors already comply)
*   **Focus Indicators:** Visible focus states for interactive elements (2px outline recommended)
*   **ARIA Labels:** Proper labeling for tool blocks, status indicators, and interactive elements
*   **Keyboard Shortcuts:** Document and support keyboard shortcuts (see section below)

### 6.10 Keyboard Shortcuts

Essential keyboard shortcuts for power users:

| Shortcut | Action | Context |
|----------|--------|---------|
| `Ctrl+Enter` / `Cmd+Enter` | Submit message | Chat input focused |
| `Shift+Enter` | New line in message | Chat input |
| `Ctrl+L` | Clear screen (scroll to top) | Anywhere |
| `Ctrl+C` | Cancel current operation | During streaming |
| `/` | Open command palette | Chat input (at start) |
| `@` | Open file/resource picker | Chat input |
| `Esc` | Close modal/cancel | Modal open |
| `↑` | Navigate to previous message | Chat input empty |
| `↓` | Navigate to next message | Chat input (after ↑) |
| `Ctrl+K` | Focus search/command palette | Anywhere |

---

## 7. Implementation Checklist

### Phase 1: Core UI (Pixel-Perfect Focus)

**Design System Implementation:**
- [ ] Set up color tokens (CSS variables or Tailwind theme)
- [ ] Configure typography (Inter + JetBrains Mono with proper weights)
- [ ] Implement spacing system (16px vertical rhythm, 24px indentation)
- [ ] Create base layout container (max-w-3xl, centered)

**Core Components:**
- [ ] MessageList with streaming support
- [ ] MessageBlock (user vs assistant styling)
- [ ] BlockRenderer (route to correct component)
- [ ] MarkdownBlock with custom renderer (marked library)
- [ ] CodeBlock with syntax highlighting (Shiki)
- [ ] DiffView (unified, with line numbers)
- [ ] ToolLog (collapsible)
- [ ] StreamingCursor (blinking █)

**Interactive Components:**
- [ ] ChatInput (with @ and / triggers)
- [ ] SessionHeader (name, tokens, model)
- [ ] QuestionBlock (AskUserQuestion)
- [ ] TodoPanel (status indicators)
- [ ] PermissionModal

**Tool Visualizations:**
- [ ] ReadTool (syntax-highlighted content)
- [ ] WriteTool (created file badge)
- [ ] EditTool (delegates to DiffView)
- [ ] BashTool (terminal output)
- [ ] GlobTool (file list with icons)
- [ ] GrepTool (search results)
- [ ] WebFetchTool (URL + content)
- [ ] WebSearchTool (result links)

**Backend Integration:**
- [ ] SSE/WebSocket streaming setup
- [ ] Message protocol implementation
- [ ] Session management endpoints
- [ ] Tool approval flow
- [ ] State persistence (localStorage/IndexedDB)

**Polish:**
- [ ] Auto-scroll with user override
- [ ] Smart collapsing for long diffs
- [ ] Loading states
- [ ] Error handling
- [ ] Keyboard shortcuts
- [ ] Accessibility (ARIA, focus management)

### Phase 2: Enhanced Features (Future)
- [ ] Session list sidebar
- [ ] File browser integration
- [ ] Command palette
- [ ] Git status integration
- [ ] Background task monitor
- [ ] MCP server management
- [ ] Context visualization
- [ ] Settings UI

### Success Criteria
- [ ] Visual parity with claude.ai/code (pixel-perfect where feasible)
- [ ] Smooth streaming experience (no flicker)
- [ ] All core tools render correctly
- [ ] Responsive on different screen sizes
- [ ] Keyboard navigation works
- [ ] Accessible to screen readers
- [ ] Fast initial load (<2s)
- [ ] Handles long conversations gracefully