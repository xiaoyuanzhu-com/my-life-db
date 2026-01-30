# Slash Commands UI Design

## Overview

Add slash command support to the Claude web UI, similar to the CLI experience. Commands are triggered by typing `/` or clicking a "/" button, with a popover showing available commands filtered in real-time.

## Requirements

1. **Two trigger methods:**
   - User types `/` at start of input
   - User clicks "/" button (left of send button)

2. **Command sources (merged):**
   - Built-in commands (hardcoded from CLI docs)
   - Dynamic `slash_commands` from `system:init` message
   - Dynamic `skills` from `system:init` message

3. **Behavior:**
   - Flat list, no grouping
   - Filter via main input (typing `/com` filters to matching commands)
   - Mouse-only selection (click to select)
   - Selection inserts command text into input
   - Popover appears above input area

## Data Model

```typescript
interface SlashCommand {
  name: string           // e.g., "compact", "clear"
  description?: string   // e.g., "Clear conversation history"
  source: 'builtin' | 'dynamic' | 'skill'
}
```

### Built-in Commands

From https://code.claude.com/docs/en/interactive-mode#built-in-commands:

| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation history |
| `/compact` | Compact conversation with optional focus instructions |
| `/config` | Open the Settings interface |
| `/context` | Visualize current context usage |
| `/cost` | Show token usage statistics |
| `/doctor` | Check installation health |
| `/exit` | Exit the REPL |
| `/export` | Export conversation to file or clipboard |
| `/help` | Get usage help |
| `/init` | Initialize project with CLAUDE.md |
| `/mcp` | Manage MCP server connections |
| `/memory` | Edit CLAUDE.md memory files |
| `/model` | Select or change AI model |
| `/permissions` | View or update permissions |
| `/plan` | Enter plan mode |
| `/rename` | Rename current session |
| `/resume` | Resume a conversation |
| `/rewind` | Rewind conversation and/or code |
| `/stats` | Visualize usage statistics |
| `/status` | Show version, model, account info |
| `/statusline` | Set up status line UI |
| `/copy` | Copy last assistant response |
| `/tasks` | List and manage background tasks |
| `/teleport` | Resume a remote session |
| `/theme` | Change color theme |
| `/todos` | List current TODO items |
| `/usage` | Show plan usage limits |
| `/vim` | Enable vim editor mode |
| `/terminal-setup` | Install terminal bindings |

### Deduplication

If a command appears in both built-in and init message, prefer the dynamic one.

## Component Structure

```
ChatInputField
├── SlashCommandButton (the "/" button)
├── textarea (main input)
├── SlashCommandPopover
│   └── CommandList (flat, filtered)
└── SendButton
```

## User Flow

1. User types `/` → popover opens showing all commands
2. User continues typing `/com` → list filters to matching commands
3. User clicks a command → command text inserted, popover closes
4. User can add arguments and press Enter to send

## Popover Behavior

- **Opens when:** `/` typed at start OR "/" button clicked
- **Closes when:**
  - Click outside popover
  - Select an item
  - Delete the `/` character
  - Press Escape
- **Position:** Above the input area

## Implementation Files

| File | Purpose |
|------|---------|
| `slash-commands.ts` | Built-in command constants |
| `use-slash-commands.ts` | Hook to merge built-in + init commands |
| `slash-command-popover.tsx` | Popover UI component |
| `chat-input-field.tsx` | Add "/" button, trigger logic |
| `chat-interface.tsx` | Pass init data to input |

## State Flow

1. `ChatInterface` receives `system:init` message with `slash_commands` and `skills`
2. Passes these to `ChatInput` → `ChatInputField`
3. `useSlashCommands` hook merges with built-in commands
4. `SlashCommandPopover` renders filtered list based on input text
