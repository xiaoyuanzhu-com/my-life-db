# Claude Code Web UI Design Document

This document outlines the features needed to implement a web UI for Claude Code, mirroring the functionality of claude.ai/code.

## Table of Contents

1. [Overview](#overview)
2. [Claude Code Features & UI Requirements](#claude-code-features--ui-requirements)
3. [Phase 1: Core Features](#phase-1-core-features)
4. [Phase 2: Enhanced Features](#phase-2-enhanced-features)
5. [Phase 3: Advanced Features](#phase-3-advanced-features)
6. [UI Component Architecture](#ui-component-architecture)

---

## Overview

### Goal
Build a web-based interface for Claude Code that provides the same capabilities as the terminal UI, with enhanced visual feedback and easier interaction patterns.

### Target Experience
Mimic [claude.ai/code](https://claude.ai/code) - an input box at the bottom with session/conversation details above.

### Key Principles
- **Parity with CLI**: All CLI features should eventually be accessible via web UI
- **Progressive disclosure**: Show basic features first, reveal advanced features as needed
- **Real-time feedback**: Stream responses, show tool execution progress
- **Keyboard-first**: Support power users with keyboard shortcuts

---

## Claude Code Features & UI Requirements

### 1. Core Tools

| Tool | Description | UI Requirements |
|------|-------------|-----------------|
| **Read** | Read file contents with optional line range | File path input, line range selector, syntax-highlighted output |
| **Write** | Create/overwrite files | File path input, content editor, confirmation dialog |
| **Edit** | Find and replace text in files | Side-by-side diff view, old/new string inputs, replace all toggle |
| **Bash** | Execute shell commands | Command input, streaming output, timeout config, background toggle |
| **Glob** | Find files by pattern | Pattern input, directory selector, file list results |
| **Grep** | Search file contents | Regex input, file type filter, context lines, output mode |
| **WebFetch** | Fetch and analyze web content | URL input, prompt input, rendered markdown output |
| **WebSearch** | Search the web | Query input, domain filters, results with links |

### 2. Task/Agent System

| Feature | Description | UI Requirements |
|---------|-------------|-----------------|
| **Subagents** | Spawn specialized agents for tasks | Agent list with status indicators, output viewer |
| **Agent Types** | Explore, Plan, Bash, General-purpose | Agent type selector, configuration panel |
| **Background Tasks** | Run agents in background | Task monitor, progress indicator, output buffer |
| **Agent Resume** | Continue previous agent work | Agent history, resume button |

### 3. AskUserQuestion Tool

Claude can ask users questions with predefined options.

**UI Requirements:**
- Modal/inline question display
- Radio buttons or checkboxes for options
- Multi-select support
- "Other" free-text input option
- Answer submission

### 4. TodoWrite (Task Management)

Claude tracks tasks in a structured todo list.

**UI Requirements:**
- Task list panel (collapsible)
- Status indicators: pending (○), in_progress (◐), completed (●)
- Current task highlighting
- Progress percentage
- Real-time updates as Claude works

### 5. MCP (Model Context Protocol)

External tool integrations via MCP servers.

**UI Requirements:**
- MCP server status indicator
- Available tools list from connected servers
- Tool permission approval interface
- Resource browser (for `@` references)
- Connection configuration UI

### 6. Slash Commands & Skills

| Command Type | Examples | UI Requirements |
|--------------|----------|-----------------|
| **Built-in** | /help, /clear, /compact, /cost | Command palette with search |
| **Custom** | User-defined in .claude/commands/ | Command creator/editor |
| **Skills** | Context-aware capabilities | Skill browser, installation UI |

### 7. Session Management

**UI Requirements:**
- Session list with metadata (name, time, messages, branch)
- Session picker with search/filter
- New session creation
- Session renaming
- Session preview
- Resume/continue session
- Forked sessions grouping
- Session export

### 8. Permissions System

| Mode | Description |
|------|-------------|
| **default** | Prompt for each operation |
| **acceptEdits** | Auto-accept file modifications |
| **plan** | Read-only exploration |
| **bypassPermissions** | Skip all checks |

**UI Requirements:**
- Permission mode indicator in header
- Permission request modal
- Allow/Deny/Always Allow buttons
- Permission history log
- Per-tool permission toggles

### 9. Hooks

Event-driven customization system.

| Hook Event | When Triggered |
|------------|----------------|
| PreToolUse | Before tool execution |
| PostToolUse | After tool completes |
| UserPromptSubmit | Before prompt processing |
| SessionStart | On session init/resume |
| Stop | Before generation stops |

**UI Requirements:**
- Hook configuration panel
- Event selector
- Command/prompt editor
- Hook execution log
- Enable/disable toggles

### 10. Context Management

**UI Requirements:**
- Context window usage visualization (progress bar/grid)
- Token count display
- Compaction trigger button
- CLAUDE.md editor
- Memory/rules viewer

### 11. Git Operations

**UI Requirements:**
- Git status indicator (branch, dirty state)
- Diff viewer for changes
- Commit message composer
- PR creation flow
- Conflict resolution UI

### 12. File Operations

**UI Requirements:**
- File browser tree view
- Syntax-highlighted file viewer
- Inline diff for edits
- Image/PDF preview
- File upload (drag & drop)

### 13. Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+C | Cancel current operation |
| Ctrl+Enter | Submit message |
| Ctrl+L | Clear screen |
| Shift+Enter | Multiline input |
| / | Open command palette |
| @ | Open file/resource picker |
| Esc | Cancel/close modal |

---

## Phase 1: Core Features

**Goal**: Basic chat interface with essential tool visualization

### 1.1 Chat Interface

```
┌─────────────────────────────────────────────────────────┐
│ Session: New conversation                    [Settings] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [User Message]                                         │
│  Help me understand the authentication flow             │
│                                                         │
│  [Claude Response]                                      │
│  I'll explore your codebase to understand the auth...   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 🔧 Tool: Grep                                    │   │
│  │ Pattern: "auth|login|session"                   │   │
│  │ ─────────────────────────────────────────────── │   │
│  │ Found 12 files...                               │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  Based on my analysis, your auth flow works...          │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ [                    Type a message...                ] │
│ [@] [/] [Attach]                         [Send ↵]      │
└─────────────────────────────────────────────────────────┘
```

### 1.2 Components to Build

1. **MessageList** - Display conversation history
   - User messages (right-aligned or distinct style)
   - Claude messages (with markdown rendering)
   - Tool invocations (collapsible blocks)
   - Tool results (syntax highlighted)

2. **ChatInput** - Message input area
   - Multi-line text input (Shift+Enter for newlines)
   - Submit on Enter
   - @ mention for files
   - / command palette trigger
   - File attachment button
   - Send button

3. **ToolBlock** - Display tool calls
   - Tool name and icon
   - Parameters display
   - Collapsible output
   - Status indicator (running/completed/failed)
   - Duration display

4. **SessionHeader** - Session info bar
   - Session name (editable)
   - Token usage indicator
   - Model indicator
   - Settings button

### 1.3 Tool Visualizations (Phase 1)

| Tool | Visualization |
|------|---------------|
| **Read** | File content with syntax highlighting, line numbers |
| **Write** | Created file path, content preview (collapsed) |
| **Edit** | Side-by-side diff view |
| **Bash** | Command + streaming output (terminal style) |
| **Glob** | File list with icons |
| **Grep** | Matched files or content with highlights |
| **WebFetch** | URL + extracted content summary |
| **WebSearch** | Search results as links |

### 1.4 AskUserQuestion UI

When Claude asks a question:

```
┌─────────────────────────────────────────────────────────┐
│  ❓ Claude needs your input                             │
│                                                         │
│  Which database should we use for this feature?         │
│                                                         │
│  ○ PostgreSQL (Recommended)                             │
│    Full-featured relational database                    │
│                                                         │
│  ○ SQLite                                               │
│    Lightweight, file-based database                     │
│                                                         │
│  ○ Other: [_______________]                             │
│                                                         │
│                              [Skip] [Submit Answer]     │
└─────────────────────────────────────────────────────────┘
```

### 1.5 TodoList Panel

Collapsible side panel or inline display:

```
┌─ Tasks (2/5 complete) ─────────────────┐
│ ● Research auth patterns               │
│ ● Design database schema               │
│ ◐ Implement user model     ← current   │
│ ○ Add API endpoints                    │
│ ○ Write tests                          │
└────────────────────────────────────────┘
```

### 1.6 Permission Requests

Modal for permission approval:

```
┌─────────────────────────────────────────────────────────┐
│  🔐 Permission Required                                 │
│                                                         │
│  Claude wants to execute a bash command:                │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ npm install express                              │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  [Deny]  [Allow Once]  [Always Allow for this tool]    │
└─────────────────────────────────────────────────────────┘
```

### 1.7 API Integration

Backend endpoints needed:

```
POST   /api/claude/chat           # Send message, get streaming response
GET    /api/claude/sessions       # List sessions
POST   /api/claude/sessions       # Create new session
GET    /api/claude/sessions/:id   # Get session details
DELETE /api/claude/sessions/:id   # Delete session
POST   /api/claude/sessions/:id/messages  # Add message to session
POST   /api/claude/tools/:name/approve    # Approve tool execution
GET    /api/claude/context        # Get context usage
```

### 1.8 State Management

```typescript
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
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: Date;
}

interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, any>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: any;
  duration?: number;
}
```

---

## Phase 2: Enhanced Features

### 2.1 Session Management
- Session list sidebar
- Session search/filter
- Session renaming
- Session forking (rewind)
- Session export

### 2.2 File Browser
- Tree view of project files
- Quick file preview
- File reference insertion (@)
- Drag & drop file attachment

### 2.3 Command Palette
- Searchable command list
- Keyboard shortcut hints
- Recent commands
- Custom command execution

### 2.4 Git Integration
- Branch indicator
- Staged/unstaged changes
- Commit message input
- Diff viewer

### 2.5 Background Tasks
- Background bash task monitor
- Task output viewer
- Kill task functionality
- Task history

### 2.6 Agent Panel
- Running agents list
- Agent output viewer
- Agent resume functionality
- Agent configuration

---

## Phase 3: Advanced Features

### 3.1 MCP Integration
- MCP server management
- Tool discovery
- Resource browser
- OAuth flow handling

### 3.2 Hooks Configuration
- Hook event browser
- Hook editor (command/prompt)
- Hook testing
- Execution logs

### 3.3 Settings UI
- Permission mode configuration
- Model selection
- Environment variables
- Keyboard shortcut customization

### 3.4 Context Visualization
- Token usage breakdown
- Context window grid view
- Compaction controls
- Memory/CLAUDE.md editor

### 3.5 Advanced Git
- PR creation flow
- Code review integration
- Conflict resolution
- Commit history

---

## UI Component Architecture

### Directory Structure

```
frontend/app/
├── components/
│   └── claude/
│       ├── ChatInterface.tsx      # Main chat container
│       ├── MessageList.tsx        # Message history display
│       ├── ChatInput.tsx          # Message input with @ and /
│       ├── SessionHeader.tsx      # Session info bar
│       ├── ToolBlock.tsx          # Tool invocation display
│       ├── AskUserQuestion.tsx    # Question modal/inline
│       ├── TodoPanel.tsx          # Task list panel
│       ├── PermissionModal.tsx    # Permission request modal
│       ├── tools/
│       │   ├── ReadTool.tsx       # Read tool visualization
│       │   ├── WriteTool.tsx      # Write tool visualization
│       │   ├── EditTool.tsx       # Edit tool with diff
│       │   ├── BashTool.tsx       # Terminal-style output
│       │   ├── GlobTool.tsx       # File list display
│       │   ├── GrepTool.tsx       # Search results
│       │   ├── WebFetchTool.tsx   # Web content display
│       │   └── WebSearchTool.tsx  # Search results links
│       ├── sidebar/
│       │   ├── SessionList.tsx    # Session management
│       │   ├── FileBrowser.tsx    # File tree
│       │   └── CommandPalette.tsx # Command search
│       └── modals/
│           ├── SettingsModal.tsx
│           └── ExportModal.tsx
├── hooks/
│   ├── useClaude.ts              # Claude API integration
│   ├── useSession.ts             # Session management
│   └── useTools.ts               # Tool state management
├── contexts/
│   └── ClaudeContext.tsx         # Global Claude state
├── routes/
│   └── claude.tsx                # Claude Code page route
└── types/
    └── claude.ts                 # TypeScript types
```

### Key Technical Decisions

1. **Streaming**: Use SSE or WebSocket for streaming Claude responses
2. **State**: React Context + TanStack Query for server state
3. **Markdown**: Use `react-markdown` with syntax highlighting
4. **Diff View**: Use `react-diff-viewer` or Monaco editor diff
5. **Terminal**: Use `xterm.js` for bash output or simple styled div
6. **File Tree**: Custom component or `react-arborist`

### Styling Approach

Use existing Tailwind + shadcn/ui patterns:
- `bg-background` / `bg-card` / `bg-muted` for surfaces
- `text-foreground` / `text-muted-foreground` for text
- `border-border` for borders
- Consistent spacing with Tailwind utilities

---

## Implementation Priority

### Phase 1 (MVP) - Focus Areas
1. Chat interface with message display
2. Tool block rendering (all core tools)
3. AskUserQuestion handling
4. TodoList display
5. Permission request modal
6. Session header with basic info
7. Streaming response support

### Success Criteria (Phase 1)
- [ ] User can send messages and see responses
- [ ] Tool invocations are clearly displayed
- [ ] Tool outputs are readable (syntax highlighting)
- [ ] User can answer Claude's questions
- [ ] Task progress is visible
- [ ] Permissions can be approved/denied
- [ ] Session context is preserved across refreshes
