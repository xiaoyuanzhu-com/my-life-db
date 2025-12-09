# FileCard Architecture

This document describes the architecture and design patterns for the FileCard component system in MyLifeDB.

## Overview

The FileCard system provides a modular, type-specific rendering architecture for displaying files in the application. It uses a registry pattern to dispatch to specialized card, modal, and context menu implementations based on file type.

## Directory Structure

```
src/components/FileCard/
├── index.ts                    # Public exports
├── file-card.tsx               # Main dispatcher component
├── file-modal.tsx              # Modal dispatcher component
├── context-menu.tsx            # Context menu dispatcher (unified desktop/mobile)
├── desktop-context-menu.tsx    # Desktop context menu wrapper (shadcn)
├── mobile-context-menu.tsx     # Mobile context menu implementation
├── types.ts                    # Shared types for cards/modals/menus
├── utils.ts                    # Shared utilities (content detection, file actions)
├── ui/
│   ├── match-context.tsx       # Search result match context display
│   └── text-highlight.tsx      # Text highlighting utilities
├── cards/
│   ├── index.ts                # Card registry and type mapping
│   ├── image-card.tsx          # PNG, JPG, JPEG, GIF, WebP, SVG
│   ├── video-card.tsx          # MP4, MOV, WebM, etc.
│   ├── audio-card.tsx          # MP3, WAV, OGG, etc.
│   ├── text-card.tsx           # MD, TXT, and files with textPreview
│   ├── screenshot-card.tsx     # Files with screenshot digest (PDFs, URLs)
│   └── fallback-card.tsx       # Unknown file types (shows filename)
├── modals/
│   ├── index.ts                # Modal registry and type mapping
│   ├── image-modal.tsx         # Full-screen image viewer
│   ├── video-modal.tsx         # Video player modal
│   ├── audio-modal.tsx         # Audio player modal
│   ├── text-modal.tsx          # Full text viewer/editor
│   ├── pdf-modal.tsx           # PDF viewer
│   └── fallback-modal.tsx      # Generic file info modal
└── menus/
    ├── index.ts                # Menu action registry
    ├── common-actions.ts       # Shared actions (Open, Pin, Delete)
    ├── image-actions.ts        # Save, Share for images
    ├── video-actions.ts        # Save, Share for videos
    ├── audio-actions.ts        # Save, Share for audio
    ├── text-actions.ts         # Copy, Expand/Collapse for text
    └── types.ts                # Menu action types
```

## Type Detection

File types are determined using a priority-based system:

```typescript
// src/components/FileCard/utils.ts

export type FileContentType =
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'screenshot'
  | 'filename';

export function getFileContentType(file: FileWithDigests): FileContentType {
  const mimeType = file.mimeType || '';

  // 1. Check MIME type first
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';

  // 2. Check for text preview
  if (file.textPreview) return 'text';

  // 3. Check for screenshot digest
  const hasScreenshot = file.screenshotSqlar ||
    file.digests?.some(d => d.type.includes('screenshot') && d.status === 'completed');
  if (hasScreenshot) return 'screenshot';

  // 4. Fallback to filename display
  return 'filename';
}
```

## MIME Type Mapping

Each card type handles specific MIME types:

| Card Type | MIME Types |
|-----------|------------|
| `image-card` | `image/png`, `image/jpeg`, `image/jpg`, `image/gif`, `image/webp`, `image/svg+xml` |
| `video-card` | `video/mp4`, `video/webm`, `video/quicktime`, `video/x-msvideo` |
| `audio-card` | `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/webm`, `audio/aac` |
| `text-card` | Files with `textPreview` field (regardless of MIME type) |
| `screenshot-card` | Files with `screenshotSqlar` or screenshot digest |
| `fallback-card` | Any file type not matching above |

## Component Architecture

### FileCard (Dispatcher)

The main `file-card.tsx` acts as a dispatcher that:

1. Detects the file content type using `getFileContentType()`
2. Renders the appropriate card from `cards/`
3. Wraps with context menu from `context-menu.tsx`
4. Handles shared state (delete dialog, preview modal)

```typescript
// Simplified structure
export function FileCard({ file, ...props }: FileCardProps) {
  const contentType = getFileContentType(file);
  const CardComponent = getCardComponent(contentType);
  const menuActions = getMenuActions(contentType, file, handlers);

  return (
    <ContextMenuWrapper actions={menuActions}>
      <CardComponent file={file} {...props} />
    </ContextMenuWrapper>
  );
}
```

### Card Components

Each card component is self-contained and manages its own state. Cards receive minimal props and handle their own logic internally (expansion, content loading, etc.).

```typescript
// src/components/FileCard/types.ts

export interface BaseCardProps {
  file: FileWithDigests;
  className?: string;
  priority?: boolean;
  onOpenPreview?: () => void;
  highlightTerms?: string[];         // For search highlighting
  matchContext?: SearchMatchContext; // Optional search context
}

// Cards manage their own state internally
// e.g., TextCard handles isExpanded, fullContent loading internally
```

### Shared UI Components

The `ui/` folder contains reusable UI pieces shared across cards:

```typescript
// src/components/FileCard/ui/match-context.tsx
export function MatchContext({ context }: { context: SearchMatchContext }) {
  // Renders semantic or keyword match context below card content
}

// src/components/FileCard/ui/text-highlight.tsx
export function highlightMatches(text: string, terms: string[]): ReactNode
export function renderHighlightedSnippet(snippet: string): ReactNode
```

Cards import and use these as needed, keeping rendering logic consistent.

### Modal Components

Modals are opened via the `FileModal` dispatcher:

```typescript
export function FileModal({ file, open, onOpenChange }: FileModalProps) {
  const contentType = getFileContentType(file);
  const ModalComponent = getModalComponent(contentType);

  return <ModalComponent file={file} open={open} onOpenChange={onOpenChange} />;
}
```

### Menu Actions

Context menu actions are composed from type-specific modules:

```typescript
// src/components/FileCard/menus/index.ts

export function getMenuActions(
  contentType: FileContentType,
  file: FileWithDigests,
  handlers: MenuHandlers
): ContextMenuAction[] {
  const common = getCommonActions(file, handlers);
  const typeSpecific = getTypeSpecificActions(contentType, file, handlers);

  return [...typeSpecific, ...common];
}
```

## Props Flow

```
FileCard (receives FileWithDigests)
  │
  ├── getFileContentType() → determines which card to use
  │
  ├── CardComponent (image/video/audio/text/screenshot/fallback)
  │     └── Renders content-specific UI
  │
  ├── ContextMenuWrapper
  │     ├── DesktopContextMenu (right-click)
  │     └── MobileContextMenu (long-press)
  │           └── Menu actions from menus/
  │
  └── FileModal (on preview click)
        └── ModalComponent (image/video/audio/text/fallback)
```

## State Management

State is distributed based on ownership:

| State | Purpose | Owner |
|-------|---------|-------|
| `isExpanded` | Text expand/collapse | TextCard (internal) |
| `fullContent` | Loaded full text | TextCard (internal) |
| `copyStatus` | Copy feedback | TextCard (internal) |
| `isPreviewOpen` | Modal visibility | FileCard (dispatcher) |
| `isDeleteDialogOpen` | Delete confirmation | FileCard (dispatcher) |

Cards are self-contained - they manage their own content state. The dispatcher only manages cross-cutting concerns (modals, delete dialogs).

## File Actions (utils.ts)

File actions are split into pure utilities and React-dependent handlers:

### Pure Utilities (no React dependencies)

```typescript
// src/components/FileCard/utils.ts

/** Download a file by creating a temporary link */
export function downloadFile(path: string, filename: string): void {
  const link = document.createElement('a');
  link.href = `/raw/${path}`;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** Share a file using Web Share API */
export async function shareFile(
  path: string,
  name: string,
  mimeType?: string
): Promise<void>

/** Share text content */
export async function shareText(title: string, text: string): Promise<void>

/** Check if Web Share API is available */
export function canShare(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.share;
}
```

### API Calls (pure async functions)

```typescript
/** Toggle pin status for a file */
export async function togglePin(path: string): Promise<boolean>

/** Delete a file */
export async function deleteFile(path: string): Promise<boolean>

/** Fetch full text content */
export async function fetchFullContent(path: string): Promise<string | null>
```

### React-Dependent Handlers

These remain in card components since they need state/router:

- `handleCopy` - needs `setCopyStatus`, content state
- `handleToggleExpand` - needs `setIsExpanded`, `setFullContent`
- Post-action refresh - needs `router.refresh()`

Cards call the pure utilities and handle state updates themselves.

## Extensibility

To add a new file type:

1. Create `cards/new-type-card.tsx` implementing `BaseCardProps`
2. Create `modals/new-type-modal.tsx` if custom modal needed
3. Create `menus/new-type-actions.ts` for type-specific actions
4. Update `utils.ts` to detect the new type
5. Register in `cards/index.ts`, `modals/index.ts`, `menus/index.ts`

---

## Context Menu System

MyLifeDB features a dual context menu system that adapts to the device type, providing an optimized experience for both desktop and mobile users.

### Desktop Context Menu

**Activation:**
- Right-click on any file card

**Appearance:**
- Traditional vertical list menu
- Positioned at cursor location
- Uses shadcn/ui ContextMenu component

**Actions Available:**
- **Open** - Navigate to library view with file selected
- **Copy** (text files only) - Copy full text content to clipboard
- **Expand/Collapse** (truncated text only) - Toggle full text view
- **Save** (media files only) - Download file to device
- **Share** (media files, if supported) - Use Web Share API
- **Delete** - Remove file with confirmation dialog

### Mobile Context Menu

**Activation:**
- Long-press (500ms) on any file card
- Cancels if user moves >10px (allows scrolling)

**Appearance:**
- Compact grid layout with icons + labels
- Maximum 5 items per row, wraps to second row if needed
- Smart positioning:
  1. Above file card (preferred)
  2. Below file card (if no space above)
  3. Middle of viewport (if no space above/below)
- Small triangle arrow points to center of file card
- Semi-transparent backdrop overlay
- Width adjusts dynamically based on number of actions

**Cell Design:**
- Icon: 20px (w-5 h-5)
- Label: 10px font size
- Padding: 8px (p-2)
- Gap between icon and label: 4px (gap-1)
- Grid gap: 4px (gap-1)
- Container padding: 4px (p-1)

**Touch Interactions:**
- Non-passive touch events allow preventDefault for text selection
- Movement detection prevents accidental triggers during scroll
- Tap outside or backdrop closes menu

### Text Selection Behavior (Text Files Only)

**Desktop:**
- Users can manually select text before right-clicking
- Selection persists when context menu opens
- Standard browser text selection UI

**Mobile:**
- Long-press automatically selects all text in the card
- System text selection UI (handles, toolbar) is suppressed
- Custom selection highlight: `rgb(180 180 255 / 30%)`
- Selection clears when menu closes
- Prevents conflicts with system selection gestures

**CSS Implementation:**
- `.mobile-menu-open` class applied to trigger element
- `-webkit-touch-callout: none` prevents iOS callout
- `user-select: text` allows programmatic selection
- Custom `::selection` styling for visual feedback

### Accessibility Features

- **Non-selectable elements:**
  - Timestamps above file cards
  - Menu icons and labels
  - Non-text file cards

- **Touch behaviors disabled:**
  - `-webkit-touch-callout: none` - iOS callout menu
  - `-webkit-tap-highlight-color: transparent` - tap flash
  - `touch-action: manipulation` - enables browser optimizations

### Visual Feedback

- Active cell scale: 95% (`active:scale-95`)
- Destructive actions: Red text color
- Disabled states: 50% opacity
- Hover/active backgrounds:
  - Default: `bg-accent`
  - Destructive: `bg-destructive/10`

### Device Detection

Touch capability detected via:
```javascript
'ontouchstart' in window || navigator.maxTouchPoints > 0
```

Desktop menu used when no touch capability detected.

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
- Match context: Selectable text content

### Mobile Optimizations

- Max card width: `calc(100% - 40px)` for right-aligned layout
- Touch target size follows platform guidelines (minimum 44x44px)
- Prevents system zoom on long-press
- Scroll-friendly with movement threshold detection

---

## Implementation Notes

### Current State (Before Refactor)

The current `file-card.tsx` is a monolithic ~740 line component that:
- Handles all file types in one component with large switch/conditional logic
- Has all context menu logic inline
- Manages all state locally
- Contains helper functions like `TextContent`, `MatchContext`, `highlightMatches`

### Migration Strategy

1. **Phase 1**: Extract shared code
   - Create `types.ts` with shared interfaces (`BaseCardProps`, `FileContentType`, etc.)
   - Create `utils.ts` with `getFileContentType()` and pure file action utilities
   - Create `ui/match-context.tsx` and `ui/text-highlight.tsx`

2. **Phase 2**: Extract card components (each self-contained with own state)
   - Start with `cards/image-card.tsx` (simplest, no internal state)
   - Then `cards/video-card.tsx`, `cards/audio-card.tsx` (simple media)
   - Then `cards/text-card.tsx` (complex - manages expand/content/copy state)
   - Then `cards/screenshot-card.tsx` and `cards/fallback-card.tsx`
   - Create `cards/index.ts` registry with `getCardComponent()`

3. **Phase 3**: Extract modal components
   - `modals/image-modal.tsx` (already exists as `file-modal.tsx`)
   - `modals/video-modal.tsx`, `modals/audio-modal.tsx`
   - `modals/text-modal.tsx` for full-screen text view
   - `modals/pdf-modal.tsx` for PDF viewing
   - `modals/fallback-modal.tsx` for generic file info
   - Create `modals/index.ts` registry with `getModalComponent()`

4. **Phase 4**: Refactor context menu system
   - Create `menus/types.ts` for action interfaces
   - Extract `menus/common-actions.ts` (Open, Pin, Delete)
   - Extract type-specific actions (`image-actions.ts`, `text-actions.ts`, etc.)
   - Create `menus/index.ts` with `getMenuActions(contentType, file)`
   - Create unified `context-menu.tsx` that composes actions and dispatches to desktop/mobile

5. **Phase 5**: Simplify main dispatcher
   - `file-card.tsx` becomes thin dispatcher (~100 lines)
   - Only manages: modal open state, delete dialog state
   - Delegates everything else to cards, modals, menus
