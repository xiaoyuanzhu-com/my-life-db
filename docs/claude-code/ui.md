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
    *   **Max-width:** Content-based (fits to text, not full width)
    *   **Display:** Inline-block (wraps to content width)
*   **Alignment:** Right-aligned (using flex justify-end on container)
*   **Typography:** Sans-serif, 15px, $text-primary, line-height 1.6
*   **No bullet indicator** - plain text only
*   **Spacing:** `16px` margin-bottom for separation from next message

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
*   Action Link: "Show full diff (XX more lines)" at bottom (if collapsed)

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

**Smart Collapsing:**
*   If diff exceeds ~20 lines, show first 5 and last 5 lines
*   Insert button/link: `Show 10 collapsed lines` or `Show full diff (XX more lines)`

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

#### AskUserQuestion Block
When Claude needs user input, display an inline question component.

**Layout:**
*   Background: Subtle highlight or card background (`$bg-subtle`)
*   Border-radius: `8px`
*   Padding: `16px`
*   Margin: `12px 0`

**Question Header:**
*   Icon: `❓` or question icon
*   Text: "Claude needs your input" (Sans, Semi-bold, $text-secondary)

**Question Text:**
*   Typography: Body text style (15px, $text-primary)
*   Margin-bottom: `12px`

**Options:**
*   Radio buttons or checkboxes (if multiSelect)
*   Each option:
    *   Label: Bold, $text-primary
    *   Description: Regular, $text-secondary, slightly smaller (14px)
    *   Padding: `8px`
    *   Hover state: Subtle background change
*   "Other" option with text input field

**Actions:**
*   Button group: right-aligned
*   "Skip" button (secondary)
*   "Submit Answer" button (primary)

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

#### Permission Request Modal
Modal overlay for tool execution approval.

**Overlay:**
*   Background: `rgba(0, 0, 0, 0.4)` (semi-transparent black)
*   Backdrop-blur: `4px` (optional, for modern browsers)

**Modal Card:**
*   Width: `480px` max
*   Background: `$bg-canvas`
*   Border-radius: `12px`
*   Box-shadow: `0 20px 25px -5px rgba(0, 0, 0, 0.1)`
*   Padding: `24px`

**Header:**
*   Icon: `🔐` or lock icon
*   Text: "Permission Required" (Sans, Bold, 16px, $text-primary)

**Description:**
*   Text: "Claude wants to execute a bash command:" (Body text)
*   Margin: `12px 0`

**Command Preview:**
*   Background: `$bg-code-block`
*   Border: `1px solid $border-light`
*   Border-radius: `6px`
*   Padding: `12px`
*   Font: Monospace, 13px
*   Color: $text-primary

**Actions:**
*   Button group: Right-aligned, flex row, `8px` gap
*   "Deny" button (secondary, gray)
*   "Allow Once" button (primary, default)
*   "Always Allow" button (primary, success color)

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

### Smart Collapsing & Expansion
Large content blocks should not dominate the screen.

*   **Rule:** If a diff exceeds ~20 lines, show the first 5 and last 5, and insert an expansion control.
*   **Button Text:** `Show 10 collapsed lines` or `Show full diff (XX more lines)`
*   **Interaction:** Click to expand inline, smooth animation preferred

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
| **WebFetch** | URL header + extracted/summarized content as markdown |
| **WebSearch** | Search query + results as clickable links with descriptions |
| **Task** | Agent name + type badge + status indicator + collapsible output |
| **AskUserQuestion** | Inline question card (see component G) |
| **TodoWrite** | Task list panel update (see component G) |

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
- Command shown in header line, not in separate box
- Output uses L-shaped indent with light gray text
- Exit code and duration on separate line with L-indent
- Success = green exit code, failure = red

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

**Anti-Patterns (DO NOT DO):**

❌ Dark terminal backgrounds for Bash output
❌ Code block containers around tool output
❌ Colored bubbles or heavy chrome
❌ Multi-line headers with parameters on separate lines
❌ Missing green bullet indicators
❌ Using `>` or `▶` instead of `●` for tool headers

### 6.2 Data Model

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

### 6.3 Tailwind CSS Utility Classes

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

### 6.4 Critical Rendering Logic

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

#### Scroll Anchoring
As the AI generates long diffs, implement smooth scroll behavior:

1.  **Stick-to-Bottom Logic:** Auto-scroll to keep cursor visible during streaming
2.  **User Override:** Allow users to scroll up without fighting auto-scroll
3.  **Smart Resume:** If user scrolls to bottom manually, re-enable auto-scroll
4.  **Smooth Animation:** Use smooth scroll behavior for better UX

**Example Implementation:**
```tsx
useEffect(() => {
  if (isStreaming && !userHasScrolledUp) {
    scrollContainerRef.current?.scrollTo({
      top: scrollContainerRef.current.scrollHeight,
      behavior: 'smooth'
    });
  }
}, [messageBlocks, isStreaming, userHasScrolledUp]);
```

### 6.5 Component Structure & Directory Organization

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

### 6.6 Backend Integration & Communication Protocol

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

### 6.7 Accessibility Considerations

*   **Keyboard Navigation:** Ensure collapsible sections are keyboard-accessible (Enter/Space to toggle)
*   **Screen Readers:** Use semantic HTML (`<details>`, `<summary>` for collapsible content)
*   **Color Contrast:** All text must meet WCAG AA standards (diff colors already comply)
*   **Focus Indicators:** Visible focus states for interactive elements (2px outline recommended)
*   **ARIA Labels:** Proper labeling for tool blocks, status indicators, and interactive elements
*   **Keyboard Shortcuts:** Document and support keyboard shortcuts (see section below)

### 6.8 Keyboard Shortcuts

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