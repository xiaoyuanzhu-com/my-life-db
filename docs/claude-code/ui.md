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
| **$bg-canvas** | `#FFFFFF` | Main page/application background. |
| **$bg-subtle** | `#F9FAFB` | Background for large code containers or "Artifact" wrappers. |
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

### A. The "User Prompt" Block
User input that initiates the conversation or task.

*   **Style:** Minimal gray background pill or plain text depending on scroll state
*   **Alignment:** Left-aligned or centered (depending on container width)
*   **Typography:** Sans-serif, $text-primary

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

### 6.1 Data Model

To replicate this effectively, structure the React/Vue components with these TypeScript interfaces:

```typescript
type MessageType = 'user' | 'assistant' | 'system';

interface DiffHunk {
  originalLineStart: number;
  lines: Array<{
    type: 'add' | 'remove' | 'context';
    content: string;
    lineNumber?: number;
  }>;
}

interface Block {
  type: 'text' | 'code' | 'diff' | 'tool_call' | 'status_list';
  content: string | DiffHunk;
  isCollapsed?: boolean; // For tool calls
  metadata?: {
    filePath?: string;
    language?: string;
    severity?: 'critical' | 'warning' | 'info';
  };
}

interface Message {
  id: string;
  type: MessageType;
  blocks: Block[];
  timestamp: Date;
  isStreaming?: boolean;
}
```

### 6.2 Tailwind CSS Utility Classes

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

### 6.3 Critical Rendering Logic

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

### 6.4 Component Structure (React Example)

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

### 6.5 Accessibility Considerations

*   **Keyboard Navigation:** Ensure collapsible sections are keyboard-accessible (Enter/Space to toggle)
*   **Screen Readers:** Use semantic HTML (`<details>`, `<summary>` for collapsible content)
*   **Color Contrast:** All text must meet WCAG AA standards (diff colors already comply)
*   **Focus Indicators:** Visible focus states for interactive elements (2px outline recommended)