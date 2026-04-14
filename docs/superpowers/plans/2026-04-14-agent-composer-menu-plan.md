# Agent Composer Menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse AgentTypeSelector, PermissionModeSelector, and ChangedFilesPopover into a `+` dropdown menu to the left of FolderPicker in the composer.

**Architecture:** New `ComposerOptionsMenu` component wraps the three controls in a DropdownMenu. FolderPicker stays inline. The `+` button is always visible.

**Tech Stack:** React, TypeScript, shadcn DropdownMenu, Tailwind CSS 4

---

## Files

- Modify: `frontend/app/components/assistant-ui/thread.tsx`

---

## Task 1: Add ComposerOptionsMenu component

**Files:**
- Modify: `frontend/app/components/assistant-ui/thread.tsx:1-37` (imports)
- Modify: `frontend/app/components/assistant-ui/thread.tsx:304-396` (Composer component)

- [ ] **Step 1: Add DropdownMenu to imports**

Find the existing `DropdownMenu` import from `~/components/ui/dropdown-menu` in `thread.tsx`. Verify it includes `DropdownMenuContent` and `DropdownMenuTrigger`. It should already include these from the `agent.tsx` usage pattern.

- [ ] **Step 2: Add Plus icon to lucide-react import**

Check the lucide-react import in `thread.tsx` — `ArrowDownIcon`, `ArrowUpIcon`, `SquareIcon` are imported. Add `Plus` to this import.

- [ ] **Step 3: Add ComposerOptionsMenu component before the Composer component**

Insert this component definition around line 303 (before `const Composer`):

```tsx
const ComposerOptionsMenu: FC<{
  agentType?: string
  onAgentTypeChange?: (type: string) => void
  permissionMode?: string
  availableModes?: Array<{ id: string; label: string }>
  onPermissionModeChange?: (mode: string) => void
  sessionId?: string
  resultCount?: number
}> = ({
  agentType,
  onAgentTypeChange,
  permissionMode,
  availableModes,
  onPermissionModeChange,
  sessionId,
  resultCount,
}) => {
  const hasActiveSession = !!sessionId
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          title="Options"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={4}>
        {agentType !== undefined && onAgentTypeChange && (
          <div className="px-2 py-1.5">
            <div className="text-xs text-muted-foreground mb-1.5">Agent</div>
            <AgentTypeSelector
              value={agentType as AgentType}
              onChange={(t) => onAgentTypeChange(t)}
              disabled={!onAgentTypeChange || hasActiveSession}
            />
          </div>
        )}
        {permissionMode !== undefined && availableModes && availableModes.length > 0 && onPermissionModeChange && (
          <div className="px-2 py-1.5">
            <div className="text-xs text-muted-foreground mb-1.5">Permission</div>
            <PermissionModeSelector
              value={permissionMode as PermissionMode}
              modes={availableModes}
              onChange={(m) => onPermissionModeChange(m)}
            />
          </div>
        )}
        {sessionId && (
          <div className="px-2 py-1.5">
            <ChangedFilesPopover sessionId={sessionId} refreshKey={resultCount ?? 0} />
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

- [ ] **Step 4: Update Composer left controls row**

In the `Composer` component's return JSX, find the div with class `aui-composer-action-wrapper`. Replace the left-side controls with:

```tsx
<div className="flex items-center gap-1">
  <ComposerOptionsMenu
    agentType={agentType}
    onAgentTypeChange={onAgentTypeChange}
    permissionMode={permissionMode}
    availableModes={availableModes}
    onPermissionModeChange={onPermissionModeChange}
    sessionId={sessionId}
    resultCount={resultCount}
  />
  {workingDir !== undefined && (
    <FolderPicker value={workingDir} onChange={onWorkingDirChange ?? undefined} readOnly={!onWorkingDirChange || hasActiveSession} />
  )}
</div>
```

Remove the old `AgentTypeSelector`, `PermissionModeSelector`, and `ChangedFilesPopover` renders from the left controls — they now live inside `ComposerOptionsMenu`.

- [ ] **Step 5: Build and verify**

Run: `cd /Users/iloahz/projects/MyLifeDB/my-life-db/frontend && npm run build 2>&1 | tail -30`

Expected: No TypeScript errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /Users/iloahz/projects/MyLifeDB/my-life-db
git add frontend/app/components/assistant-ui/thread.tsx
git commit -m "feat(agent): collapse composer options into + dropdown menu"
```

---

## Verification

After building, manually test at http://localhost:12346/agent:
1. Verify `+` button appears to the left of FolderPicker
2. Click `+` — verify dropdown shows Agent, Permission, and (if session active) Changed Files
3. Verify FolderPicker is still directly visible
4. Verify send/stop button still works on the right
