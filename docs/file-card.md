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

---

## UX Specifications by File Type

This section documents the detailed UX behavior for each file type.

### Common Properties

**Card Container:**
- Rounded corners (`rounded-lg`), border, muted background
- Max width: `calc(100% - 40px)` to allow timestamp alignment
- Selection: `touch-callout-none select-none` (except text cards)
- Match context displayed at bottom when from search results

**Context Menu Activation:**
- Desktop: Right-click
- Mobile: Long-press (500ms)

**Available Context Menu Actions:**

| Action | Icon | Behavior | Used By |
|--------|------|----------|---------|
| Open | ExternalLink | Navigate to library page | All |
| Pin/Unpin | Pin | Toggle pinned state, reload page | All |
| Save | Download | Download file to device | All except Text |
| Share | Share2 | Native share API (hidden if unavailable) | All except Text |
| Copy | Copy | Copy text content to clipboard | Text only |
| Expand/Collapse | ChevronDown/Up | Toggle text truncation | Text only (if >50 lines) |
| Delete | Trash2 | Show confirmation dialog | All |

---

### Image Card

**Card:**
- Displays image with `object-contain`
- Min: 100×100px, Max: `min(100vw - 40px, 448px)` × 320px
- Aspect ratio preserved
- Click opens modal
- Loading: lazy (eager when `priority` prop)

**Modal:**
- Full-screen overlay (90vw × 90vh max)
- Transparent background, no border
- Click anywhere to dismiss

**Context Menu:**
Open, Pin, Save, Share, Delete

---

### Video Card

**Card:**
- Fixed 16:9 aspect ratio
- Max width: 448px
- Native `<video>` with controls
- Black background for letterboxing
- `playsInline`, `muted`, `preload="metadata"`

**Modal:**
None (native fullscreen via video controls)

**Context Menu:**
Open, Pin, Save, Share, Delete

---

### Audio Card

**Card:**
- WeChat-style single bar design
- Width: Based on audio duration, capped at `50% - 40px`, min 100px
- Fixed height (compact single bar)
- No filename displayed
- Shows audio duration (e.g., `5"` for 5 seconds)
- Click to play, click again to pause
- Background color fill shows playback progress

**Interaction:**
- Tap/click (no drag): Toggle play/pause
- Drag (≥10px movement): Scrub seek with visual preview, seek applied on release
- Dragging outside the bar continues tracking until mouse release
- Progress indicated by background color fill (left to right)
- Duration displayed on right side

**Modal:**
None

**Context Menu:**
Open, Pin, Save, Share, Delete

---

### Text Card

**Card:**
- Prose styling with `whitespace-pre-wrap`, `break-words`
- Text selectable (`select-text`)
- Max 20 lines shown (truncated with "...")
- Search term highlighting supported
- Double-click opens modal with full content

**Modal:**
- Full content with scroll
- Touch-friendly close button (top-right)
- Lazy loads full content when opened

**Context Menu:**
Open, Pin, Copy, Delete

**Special:**
- `selectTextOnOpen` enabled
- Mobile long-press auto-selects all text

---

### PDF Card

**Card:**
- Fixed width: 226px (A4-ish aspect ratio)
- With screenshot: Image display (max height 320px, aspect ratio preserved) with filename + size footer
- Without screenshot: Filename + "PDF Document" label (min height 120px)
- Footer: filename (left) and size (right), `justify-between`
- Filename: middle-truncated with ellipsis (e.g., "docum...nt.pdf")
- Truncation uses visual weight: English/digits = 2, CJK = 3, max weight 42
- Size format: human-readable with max 1 decimal (5KB, 14.3MB, 20GB)
- Click opens modal

**Modal:**
- Full PDF viewer using react-pdf (lazy-loaded, separate bundle)
- Page navigation with prev/next buttons (hidden for single-page PDFs)
- Page counter showing current/total
- Max width 800px, responsive to viewport
- pdf.js worker loaded via Vite `?url` import (no CDN dependency)

**Context Menu:**
Preview, Open, Pin, Save, Share, Delete

---

### Document Card (Word)

**Card:**
- Same layout as PDF Card (226px fixed width, footer with filename + size)
- Without screenshot: Filename + "Word Document" label

**Modal:**
None

**Context Menu:**
Open, Pin, Save, Share, Delete

---

### PowerPoint Card

**Card:**
- With screenshot: Same as PDF
- Without screenshot: Filename + "PowerPoint Presentation" label

**Modal:**
None

**Context Menu:**
Open, Pin, Save, Share, Delete

---

### EPUB Card

**Card:**
- With screenshot: Cover image (same sizing as PDF)
- Without screenshot: Filename + "EPUB eBook" label

**Modal:**
None

**Context Menu:**
Open, Pin, Save, Share, Delete

---

### Excel Card

**Card:**
- With screenshot: Same as PDF
- Without screenshot: Filename + "Excel Spreadsheet" label

**Modal:**
None

**Context Menu:**
Open, Pin, Save, Share, Delete

---

### Fallback Card

**Card:**
- Centered filename
- MIME type below (if available)
- Min height: 120px

**Modal:**
None (info modal exists but not connected)

**Context Menu:**
Open, Pin, Save, Share, Delete

---

## Size Reference

| Card Type | Width | Height | Notes |
|-----------|-------|--------|-------|
| Image | fit-content, max 448px | max 320px | Aspect ratio preserved |
| Video | max 448px | 16:9 aspect | Fixed aspect ratio |
| Audio | duration-based, max 50%-40px, min 100px | fixed 40px | WeChat-style bar |
| Text | fit-content | max 20 lines | Double-click for modal |
| PDF/Doc | fixed 226px | max 320px + footer | A4-ish ratio, filename + size footer |
| PPT/EPUB/XLS | fit-content, max 448px | max 320px | Screenshot or fallback |
| Fallback | fit-content | min 120px | Filename only |

---

## Screenshot-Based Cards

PDF, DOC, PPT, EPUB, XLS use AI-generated screenshots stored in SQLAR.

- Source: `getScreenshotUrl(file)` → `/api/digest/{path}/screenshot`
- Dimensions: Same as image card (448px × 320px max)
- Fallback: Filename + type label when no screenshot available
