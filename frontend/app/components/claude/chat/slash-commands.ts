export interface SlashCommand {
  name: string
  description: string
  source: 'builtin' | 'dynamic' | 'skill'
}

/**
 * Built-in slash commands from Claude Code CLI.
 * Source: https://code.claude.com/docs/en/interactive-mode#built-in-commands
 */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Clear conversation history', source: 'builtin' },
  { name: 'compact', description: 'Compact conversation with optional focus instructions', source: 'builtin' },
  { name: 'config', description: 'Open the Settings interface', source: 'builtin' },
  { name: 'context', description: 'Visualize current context usage', source: 'builtin' },
  { name: 'cost', description: 'Show token usage statistics', source: 'builtin' },
  { name: 'doctor', description: 'Check installation health', source: 'builtin' },
  { name: 'exit', description: 'Exit the REPL', source: 'builtin' },
  { name: 'export', description: 'Export conversation to file or clipboard', source: 'builtin' },
  { name: 'help', description: 'Get usage help', source: 'builtin' },
  { name: 'init', description: 'Initialize project with CLAUDE.md', source: 'builtin' },
  { name: 'mcp', description: 'Manage MCP server connections', source: 'builtin' },
  { name: 'memory', description: 'Edit CLAUDE.md memory files', source: 'builtin' },
  { name: 'model', description: 'Select or change AI model', source: 'builtin' },
  { name: 'permissions', description: 'View or update permissions', source: 'builtin' },
  { name: 'plan', description: 'Enter plan mode', source: 'builtin' },
  { name: 'rename', description: 'Rename current session', source: 'builtin' },
  { name: 'resume', description: 'Resume a conversation', source: 'builtin' },
  { name: 'rewind', description: 'Rewind conversation and/or code', source: 'builtin' },
  { name: 'stats', description: 'Visualize usage statistics', source: 'builtin' },
  { name: 'status', description: 'Show version, model, account info', source: 'builtin' },
  { name: 'statusline', description: 'Set up status line UI', source: 'builtin' },
  { name: 'copy', description: 'Copy last assistant response', source: 'builtin' },
  { name: 'tasks', description: 'List and manage background tasks', source: 'builtin' },
  { name: 'teleport', description: 'Resume a remote session', source: 'builtin' },
  { name: 'theme', description: 'Change color theme', source: 'builtin' },
  { name: 'todos', description: 'List current TODO items', source: 'builtin' },
  { name: 'usage', description: 'Show plan usage limits', source: 'builtin' },
  { name: 'vim', description: 'Enable vim editor mode', source: 'builtin' },
  { name: 'terminal-setup', description: 'Install terminal bindings', source: 'builtin' },
]
