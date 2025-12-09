# FileCard Architecture

This document describes the architecture and design patterns for the FileCard component system in MyLifeDB.

## Overview

The FileCard system provides a modular, type-specific rendering architecture for displaying files in the application. Each card type is self-contained: it renders its own content, manages its own state, and owns its context menu.

## Directory Structure

```
app/components/FileCard/
├── index.ts                    # Public exports
├── types.ts                    # Shared types (BaseCardProps, FileContentType, etc.)
├── utils.ts                    # Content detection, file actions (download, share, etc.)
├── file-card.tsx               # Thin dispatcher (~50 lines)
├── file-modal.tsx              # Modal dispatcher
├── desktop-context-menu.tsx    # Desktop context menu wrapper (shadcn)
├── mobile-context-menu.tsx     # Mobile context menu implementation
├── ui/
│   ├── match-context.tsx       # Search result match context display
│   ├── text-highlight.tsx      # Text highlighting utilities
│   └── delete-confirm-dialog.tsx  # Shared delete confirmation dialog
├── cards/
│   ├── index.ts                # Card registry: getCardComponent(type)
│   ├── image-card.tsx          # PNG, JPG, JPEG, GIF, WebP, SVG
│   ├── video-card.tsx          # MP4, MOV, WebM, etc.
│   ├── audio-card.tsx          # MP3, WAV, OGG, etc.
│   ├── text-card.tsx           # MD, TXT, and files with textPreview
│   ├── pdf-card.tsx            # PDF files (renders screenshot)
│   ├── doc-card.tsx            # Word documents (renders screenshot)
│   ├── ppt-card.tsx            # PowerPoint files (renders screenshot)
│   └── fallback-card.tsx       # Unknown file types (shows filename)
└── modals/
    ├── index.ts                # Modal registry: getModalComponent(type)
    ├── image-modal.tsx         # Full-screen image viewer
    └── fallback-modal.tsx      # Generic file info modal
```

## Type Detection

File types are determined using MIME type first, then file extension as fallback:

```typescript
// app/components/FileCard/utils.ts

export type FileContentType =
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'pdf'
  | 'doc'
  | 'ppt'
  | 'fallback';

export function getFileContentType(file: FileWithDigests): FileContentType {
  const mimeType = file.mimeType || '';
  const ext = getExtension(file.name);

  // 1. Media types (by MIME)
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';

  // 2. Document types (by MIME or extension)
  if (mimeType === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (isWordDocument(mimeType, ext)) return 'doc';
  if (isPowerPoint(mimeType, ext)) return 'ppt';

  // 3. Text content (has preview)
  if (file.textPreview) return 'text';

  // 4. Fallback
  return 'fallback';
}
```

## MIME Type / Extension Mapping

| Card Type | MIME Types | Extensions |
|-----------|------------|------------|
| `image-card` | `image/*` | - |
| `video-card` | `video/*` | - |
| `audio-card` | `audio/*` | - |
| `text-card` | Files with `textPreview` field | - |
| `pdf-card` | `application/pdf` | `.pdf` |
| `doc-card` | `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `.doc`, `.docx` |
| `ppt-card` | `application/vnd.ms-powerpoint`, `application/vnd.openxmlformats-officedocument.presentationml.presentation` | `.ppt`, `.pptx` |
| `fallback-card` | Any file type not matching above | - |

## Component Architecture

### FileCard (Thin Dispatcher)

The main `file-card.tsx` is a thin dispatcher (~50 lines) that:

1. Detects the file content type using `getFileContentType()`
2. Renders the appropriate card from `cards/`
3. Passes through props (file, className, highlightTerms, matchContext, etc.)

```typescript
export function FileCard({ file, showTimestamp, ...props }: FileCardProps) {
  const contentType = getFileContentType(file);
  const CardComponent = getCardComponent(contentType);

  return (
    <div className="w-full flex flex-col items-end">
      {showTimestamp && <Timestamp date={file.createdAt} />}
      <CardComponent file={file} {...props} />
    </div>
  );
}
```

### Card Components (Self-Contained)

Each card component is **fully self-contained**:
- Renders its own content
- Manages its own internal state (e.g., TextCard owns `isExpanded`, `copyStatus`)
- Renders its own context menu (desktop + mobile)
- Handles its own actions using shared utilities from `utils.ts`

```typescript
// app/components/FileCard/types.ts

export interface BaseCardProps {
  file: FileWithDigests;
  className?: string;
  priority?: boolean;
  highlightTerms?: string[];
  matchContext?: SearchResultItem['matchContext'];
}
```

Example card structure:

```typescript
// cards/image-card.tsx
export function ImageCard({ file, className, priority, matchContext }: BaseCardProps) {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const actions = [
    { icon: ExternalLink, label: 'Open', onClick: handleOpen },
    { icon: Pin, label: file.isPinned ? 'Unpin' : 'Pin', onClick: () => togglePin(file.path) },
    { icon: Download, label: 'Save', onClick: () => downloadFile(file.path, file.name) },
    { icon: Share2, label: 'Share', onClick: handleShare, hidden: !canShare() },
    { icon: Trash2, label: 'Delete', onClick: () => setIsDeleteDialogOpen(true), variant: 'destructive' },
  ];

  const cardContent = (
    <div className={cn("...", className)}>
      <img src={`/raw/${file.path}`} ... />
      {matchContext && <MatchContext context={matchContext} />}
    </div>
  );

  return (
    <>
      <ContextMenuWrapper actions={actions}>
        {cardContent}
      </ContextMenuWrapper>
      <ImageModal open={isPreviewOpen} onOpenChange={setIsPreviewOpen} file={file} />
      <DeleteConfirmDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen} file={file} />
    </>
  );
}
```

### Shared UI Components

The `ui/` folder contains reusable pieces shared across cards:

```typescript
// ui/match-context.tsx
export function MatchContext({ context }: { context: SearchMatchContext })

// ui/text-highlight.tsx
export function highlightMatches(text: string, terms: string[]): ReactNode
export function renderHighlightedSnippet(snippet: string): ReactNode

// ui/delete-confirm-dialog.tsx
export function DeleteConfirmDialog({ open, onOpenChange, file }: DeleteConfirmDialogProps)
```

### Context Menu (Unified Wrapper)

Cards use a unified context menu wrapper that handles both desktop and mobile:

```typescript
// Detects touch capability and renders appropriate menu
export function ContextMenuWrapper({
  actions,
  children,
  selectTextOnOpen?: boolean  // For text cards
}: ContextMenuWrapperProps)
```

Each card builds its own action list and passes to the wrapper. Shared actions use utilities from `utils.ts`.

### Modal Components

Modals are simple - currently only `image-modal.tsx` exists. Others can be added as needed:

```typescript
// modals/image-modal.tsx - Full-screen image viewer
// modals/fallback-modal.tsx - Generic file info display
```

## Props Flow

```
FileCard (receives FileWithDigests)
  │
  ├── getFileContentType() → determines which card to use
  │
  └── CardComponent (self-contained)
        ├── Renders content
        ├── Owns internal state (expand, copy, preview, delete dialog)
        ├── Builds action list
        ├── Renders ContextMenuWrapper with actions
        ├── Renders Modal (if applicable)
        └── Renders DeleteConfirmDialog
```

## State Management

State is owned by individual cards:

| State | Purpose | Owner |
|-------|---------|-------|
| `isExpanded` | Text expand/collapse | TextCard |
| `fullContent` | Loaded full text | TextCard |
| `copyStatus` | Copy feedback | TextCard |
| `isPreviewOpen` | Modal visibility | Each card that supports preview |
| `isDeleteDialogOpen` | Delete confirmation | Each card |

The dispatcher (`FileCard`) has **no state** - it's purely a routing component.

## File Actions (utils.ts)

Shared utilities used by all cards:

```typescript
// Content detection
export function getFileContentType(file: FileWithDigests): FileContentType
export function getExtension(filename: string): string

// File operations (pure functions)
export function downloadFile(path: string, filename: string): void
export async function shareFile(path: string, name: string, mimeType?: string): Promise<void>
export async function shareText(title: string, text: string): Promise<void>
export function canShare(): boolean

// API calls
export async function togglePin(path: string): Promise<boolean>
export async function deleteFile(path: string): Promise<boolean>
export async function fetchFullContent(path: string): Promise<string | null>

// Touch detection
export function isTouchDevice(): boolean
```

## Extensibility

To add a new file type:

1. Add type to `FileContentType` in `types.ts`
2. Create `cards/new-type-card.tsx` implementing `BaseCardProps`
3. Update `getFileContentType()` in `utils.ts` with detection logic
4. Register in `cards/index.ts` registry
5. (Optional) Create modal in `modals/` if custom preview needed

---

## Context Menu System

### Desktop Context Menu

**Activation:** Right-click on any file card

**Appearance:**
- Traditional vertical list menu
- Positioned at cursor location
- Uses shadcn/ui ContextMenu component

### Mobile Context Menu

**Activation:** Long-press (500ms) on any file card

**Appearance:**
- Compact grid layout with icons + labels
- Maximum 5 items per row
- Smart positioning (above/below/middle of viewport)
- Semi-transparent backdrop overlay

**Touch Interactions:**
- Movement detection prevents accidental triggers during scroll
- Tap outside or backdrop closes menu

### Text Selection (Text Files Only)

**Desktop:** Users can manually select text before right-clicking

**Mobile:** Long-press automatically selects all text in the card with custom highlight styling

---

## File Card Interactions

### Visual States

- **Default:** Border + muted background
- **Group hover:** Subtle visual feedback
- **Long-press (mobile):** Text selection + context menu
- **Right-click (desktop):** Context menu

### Selection Constraints

- Text files: Text selectable, card container not selectable
- Media files: Entire card non-selectable
- Timestamps: Always non-selectable
