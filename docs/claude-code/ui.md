# Claude Code Web UI Guidelines (Reverse Engineering)

## 1. Core Visual Concept: "The Modern Paper"
The interface mimics a continuous, cleaner version of a terminal log mixed with a rich-text editor. It abandons strict "chat bubbles" in favor of a document-like flow where user inputs and AI outputs blend almost seamlessly, differentiated primarily by content type and subtle indentation rather than heavy containers.

### Key Aesthetic Pillars
*   **Minimal Chrome:** Almost no borders or boxes around text sections.
*   **Typography-Driven Hierarchy:** Structure is created via font weight, size, and very specific monospaced vs. sans-serif pairings.
*   **Pastel & Semantic Coding:** Colors are reserved for *status* (red/green diffs) or *syntax* (code highlighting). The rest is neutral grayscale.
*   **Compact Verticality:** Tight line heights and margins to maximize information density.

---

## 2. Color Palette & Theming (Light Mode)

The UI relies on a specific range of cool grays and distinct "diff" colors.

| Token | Estimated Hex | Usage |
| :--- | :--- | :--- |
| **$bg-base** | `#FFFFFF` | Main application background. |
| **$bg-code-block** | `#F5F5F5` | Background for standard code snippets (inline and block). |
| **$text-primary** | `#1A1A1A` | Main body text. |
| **$text-secondary** | `#5F6368` | Metadata, file paths, collapsed summary text. |
| **$text-system** | `#4A4A4A` | System messages or tool outputs (often monospaced). |
| **$border-light** | `#E5E7EB` | Subtle dividers between major sections. |
| **$diff-add-bg** | `#E6FFEC` | Background for added lines (light green). |
| **$diff-add-text** | `#22863A` | Text color for additions. |
| **$diff-del-bg** | `#FFEBE9` | Background for deleted lines (light red). |
| **$diff-del-text** | `#CB2431` | Text color for deletions. |
| **$accent-edit** | `#FAF9F6` | Very subtle off-white/beige background for large file edit containers. |
| **$status-warning** | `#D97706` | Warning icons/text (Orange). |
| **$status-critical** | `#D92D20` | Critical/Error icons (Red). |

---

## 3. Typography Model

The interface strictly defines two distinct font families.

*   **Font A (Main/UI):** A clean Sans-Serif (likely `Tiémpos` for serif/headings or `Inter`/`System UI` for UI text).
    *   *Usage:* Conversational text, list items, headings.
*   **Font B (Code/Mono):** A highly readable Monospace (likely `JetBrains Mono`, `Fira Code`, or `Menlo`).
    *   *Usage:* File paths, tool logs, code blocks, diffs, terminal outputs.

### Type Scale (Approximation)

*   **H1 / Title:** `16px-18px`, Bold, Sans-Serif ($text-primary).
*   **Body:** `15px`, Regular, Sans-Serif ($text-primary). line-height: 1.6.
*   **Metadata:** `13px`, Regular, Monospace ($text-secondary).
*   **Code:** `13px`, Regular, Monospace.
*   **Bullet Points:** Standard bullets (`•`) or Dash (`-`) indented by `24px`.

---

## 4. Component Architecture

The page is a linear stream of **"Blocks."** Each block handles a specific type of content.

### A. Example Block: "The User Prompt"
Note: The screenshot shows mostly machine output, but the prompt at the top ("Please scan recent...") sets the context.
*   **Style:** Minimal gray background pill or plain text depending on scroll state.
*   **Alignment:** Left-aligned or Centered (depending on container width).

### B. Example Block: "Tool Use / System Log" (Collapsible)
This is a critical component for the "Claude Code" feel. It represents thinking or terminal actions.

*   **Appearance:**
    *   Icon: Right-pointing caret `> ` (indicating collapsed) or Down-pointing caret `v` (expanded).
    *   Text: Monospace. e.g., `> Read 3 files`.
    *   Color: $text-secondary.
    *   Interaction: Click to expand/collapse details.
*   **Expanded State:**
    *   Reveals a list of files or actions.
    *   No framing box; it simply pushes content down.

### C. Example Block: "The Structured Response" (Markdown)
*   **Headers:** Bold text.
*   **Lists:** Standard unordered/ordered lists.
*   **Inline Code:** Surrounded by single backticks, rendered with `$bg-code-block` and `$text-primary`.

### D. The "File Edit" Container (Complex Component)
This is the most visually distinct element in the screenshot (e.g., specific file diffs).

<details>
<summary><strong>Specs for File Edit Container</strong></summary>

1.  **Header:**
    *   Icon: Specific file type icon (Go, JS, etc.) or generic file icon.
    *   Text: `path/to/file.go` (Monospace, Bold).
    *   Action: "Show full diff (XX more lines)" link at the bottom.
2.  **The Diff View:**
    *   **Layout:** Single-column view (not side-by-side).
    *   **Line Numbers:** Left gutter, fixed width (`40px`), muted color.
    *   **Hunks:**
        *   **Context:** White background, normal text opacity.
        *   **Deletion:** `$diff-del-bg`, text strikethrough (optional), `$diff-del-text`.
        *   **Addition:** `$diff-add-bg`, `$diff-add-text`.
    *   **Syntax Highlighting:** Full language-specific syntax highlighting must be applied *on top* of the diff colors.
3.  **Surrounding Decor:**
    *   The container often has rounded corners (`8px`) and a very light border ($border-light).
    *   It sits slightly inset from the main text flow.

</details>

---

## 5. Interaction & "Feel" Guidelines

### The "Streaming" Effect
*   The UI must handle data streaming. Diffs shouldn't "pop" in all at once; they should flow.
*   **Cursor:** While generating, a blinking block cursor `█` often appears at the end of the stream.

### Visual Density Rules
1.  **Padding:** Use `16px` vertical rhythm between text paragraphs.
2.  **Indent:** Use `24px` left indentation for nested lists or "thinking" blocks.
3.  **Code Block Padding:** `16px` internal padding for code blocks. `4px` vertical margin for inline code.

### Iconography
*   **Style:** Line/Stroke icons (1.5px stroke width).
*   **Set:** Lucide React or similar clean icon set.
*   **Status Indicators:**
    *   🔴 `12px` circle for "Critical Security Issues".
    *   🟠 `12px` circle for "Memory & Resource Leaks".
    *   Use emojis directly in the text flow 🔴 🟠 🟡 as seen in the screenshot for status bullets.

---

## 6. Implementation Checklist for Engineering

To replicate this effectively, the engineer should structure the React/Vue components as follows:

### Data Model
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
  type: 'text' | 'code' | 'diff' | 'tool_call';
  content: string | DiffHunk;
  isCollapsed?: boolean; // For tool calls
  metadata?: {
    filePath?: string;
    language?: string;
    severity?: 'critical' | 'warning' | 'info';
  };
}
```

### CSS / Tailwind Utility Classes (Approximation)

*   **Markdown Text:** `text-[15px] leading-relaxed text-gray-900 font-sans`
*   **Inline Code:** `font-mono text-[13px] bg-gray-100 px-1 py-0.5 rounded text-gray-800`
*   **File Path Header:** `font-mono text-xs text-gray-500 flex items-center gap-2 mb-2`
*   **Diff Add Line:** `bg-[#e6ffec] text-[#22863a] font-mono whitespace-pre`
*   **Diff Delete Line:** `bg-[#ffebe9] text-[#cb2431] font-mono whitespace-pre`

### Critical Rendering Logic
1.  **Markdown Parser:** You need a parser that supports standard Markdown but *extends* it to support custom collapsible sections (`> Read 3 files`) and specific file diff block rendering.
2.  **Syntax Highlighter:** Use `Shiki`. It is crucial that the highlighter theme matches the light, high-contrast theme seen here. Do not use a dark theme for code blocks in this specific UI mode.
3.  **Scroll Anchoring:** As the AI generates long diffs, the viewport must handle "stick-to-bottom" logic smoothly, but allow the user to scroll up without fighting the auto-scroll.