# Claude Code

Claude Code stores every session as JSONL files on your local machine — no export needed.

## What you can export

- Per-project session folders under `~/.claude/projects/`
- Each session: messages, tool calls, results (JSONL)
- Todos, permissions, and memory files

## Recommended

1. Sessions live at `~/.claude/projects/<project-slug>/`.
2. Symlink or copy that folder into `imports/claude-code/`.
3. MyLifeDB's file watcher picks up new sessions automatically.

[Start with agent →](mld:Help me symlink ~/.claude/projects/ into imports/claude-code/ for live indexing. Walk me through the ln -s command.)

## Where it lands

`imports/claude-code/`
