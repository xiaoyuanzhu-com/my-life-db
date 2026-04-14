# Agent Composer Menu — Design Spec

## Summary

Simplify the agent page composer UI by collapsing secondary controls (AgentTypeSelector, PermissionModeSelector, ChangedFilesPopover) into a `+` dropdown menu, placing it to the left of FolderPicker. FolderPicker remains directly visible.

## Layout

```
[+ menu] [FolderPicker]                    ...right side...
```

The `+` button is always visible (no badge), opens a dropdown containing:
- AgentTypeSelector
- PermissionModeSelector
- ChangedFilesPopover

Send/Stop button remains on the right side unchanged.

## Components

### New: ComposerOptionsMenu
- A `DropdownMenu` triggered by a `+` icon button
- Button size matches FolderPicker (~h-9 w-auto or similar)
- Always visible (no conditional rendering)
- Dropdown menu items:
  - AgentTypeSelector (disabled when no session is active)
  - PermissionModeSelector (disabled when no session is active)
  - ChangedFilesPopover (only rendered if sessionId exists)
- Dropdown alignment: below-left of the `+` button

### Modified: Composer left controls row
- Old: `[FolderPicker] [AgentTypeSelector] [PermissionModeSelector] [ChangedFilesPopover]`
- New: `[+ menu with all three] [FolderPicker]`
- ChangedFilesPopover only rendered inside the dropdown when `sessionId` is set

## Behavior

- `+` button uses `Plus` icon from lucide-react (same as the session list new-button)
- Dropdown uses existing `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem` shadcn components
- AgentTypeSelector and PermissionModeSelector disabled state preserved (already controlled by `disabled={!onAgentTypeChange || hasActiveSession}`)
- ChangedFilesPopover refreshKey unchanged

## File Changes

- `frontend/app/components/assistant-ui/thread.tsx` — Modify `Composer` component to use new layout
- No new files required

## Out of Scope

- Send/Stop button behavior
- Draft persistence
- Slash commands
- Connection status banner
