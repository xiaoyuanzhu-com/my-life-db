# Agent Session Changed Files

Display files changed during an agent session, similar to `git status` output.

## Data Model

```typescript
interface ChangedFilesResponse {
  source: "git" | "tools"
  files: ChangedFile[]
}

interface ChangedFile {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked"
}
```

## Backend

**Endpoint:** `GET /api/agent/sessions/:id/changed-files`

1. Look up session → get `workingDir`
2. Check if `workingDir` is a git repo (`git rev-parse --git-dir`)
3. **Git path:** run `git status --porcelain` in `workingDir`, parse output:
   - `A`, `??` → added
   - `M` → modified
   - `D` → deleted
   - `R` → renamed
4. **Non-git path:** scan session's raw messages for `tool_call` frames where `toolName` ∈ {Write, Edit, putFile, deleteFile}, extract `file_path` from `rawInput`, deduplicate, infer status:
   - Write → added
   - Edit → modified
   - deleteFile → deleted
5. Return `ChangedFilesResponse` (empty `files` array if no changes)

## Frontend

### Action bar (composer)
- Only renders when `files.length > 0`
- File icon + count badge (e.g., `3`)
- Click toggles popover

### Popover (above composer, attached like permissions)
- Smooth expand/collapse animation
- Flat list: colored status letter + relative path (monospace)
  - `A` green, `M` yellow, `D` red, `R` blue, `?` gray
- Compact layout

### Data fetching
- Fetch on session load
- Re-fetch after each turn completes (`result` notification)
- No continuous polling
