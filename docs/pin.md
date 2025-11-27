# Pin Feature

The pin feature allows users to bookmark important inbox items for quick access. Pinned items appear as clickable tags above the input box, enabling fast navigation to frequently accessed files.

## User Experience

### Pinning Items

Users can pin/unpin items through the FileCard context menu:

1. **Mobile**: Tap the three-dot menu → Select "Pin" or "Unpin"
2. **Desktop**: Right-click the card → Select "Pin" or "Unpin"

### Viewing Pinned Items

Pinned items appear as small badge-style tags above the OmniInput box:
- Pin icon on the left
- Truncated display text (first line of content or filename)
- X button on hover for quick unpinning
- Hidden when no items are pinned

### Navigating to Pinned Items

Click any pinned tag to:
1. Load the batch containing that item (if not currently visible)
2. Scroll to the item with smooth animation
3. Highlight the item briefly with a background color transition

After jumping to a pinned item, users can scroll up/down normally to load adjacent batches via infinite scroll.

## Technical Architecture

### Database Schema

**pins table** (migration 031):
```sql
CREATE TABLE pins (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  pinned_at TEXT NOT NULL,
  display_text TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE INDEX idx_pins_file_path ON pins(file_path);
CREATE INDEX idx_pins_pinned_at ON pins(pinned_at DESC);
```

**Key Design Decisions**:
- Separate `pins` table instead of extending `files` table (most files are not pinned)
- Foreign key CASCADE ensures pins are deleted when files are removed
- `display_text` cached for performance (avoids re-reading file content)
- Uses file path as reference (not synthetic item IDs)

### Database Operations

**src/lib/db/pins.ts**:
- `pinFile(path)` - Create a pin for a file
- `unpinFile(path)` - Remove a pin
- `togglePinFile(path)` - Toggle pin state
- `isPinned(path)` - Check if file is pinned
- `listPinnedFiles(pathPrefix)` - Get all pinned items for a prefix
- `getDisplayText(file)` - Extract first line of text or filename

### API Endpoints

#### POST /api/library/pin
Toggle pin state for a file.

**Request**:
```json
{
  "path": "inbox/example.md"
}
```

**Response**:
```json
{
  "isPinned": true
}
```

**Side Effects**:
- Broadcasts `pin-changed` notification to all connected clients
- Triggers UI refresh across all browsers/tabs

#### GET /api/inbox/pinned
List all pinned inbox items.

**Response**:
```json
{
  "items": [
    {
      "path": "inbox/example.md",
      "name": "example.md",
      "pinnedAt": "2025-01-26T10:00:00.000Z",
      "displayText": "Important note about..."
    }
  ]
}
```

#### GET /api/inbox/position?path=inbox/example.md
Calculate item position for pagination.

**Response**:
```json
{
  "path": "inbox/example.md",
  "position": 6234,
  "total": 10000,
  "batchOffset": 6210,
  "batchSize": 30
}
```

Uses SQL COUNT to calculate position efficiently:
```sql
SELECT COUNT(*) as position
FROM files
WHERE path LIKE 'inbox/%'
  AND (
    created_at > ?
    OR (created_at = ? AND path > ?)
  )
```

### Smart Pagination

The pin feature implements smart pagination to handle large lists efficiently:

**Problem**: Scrolling to item #6234 in a list of 10,000 items with batch size 30.

**Solution**:
1. User clicks pinned tag
2. System calls `/api/inbox/position` to calculate item position (6234)
3. System calculates batch offset: `Math.floor(6234 / 30) * 30 = 6210`
4. System loads ONLY items 6210-6239 (not all 10,000)
5. System scrolls to item and highlights it
6. User can scroll up/down to load adjacent batches normally

**Bi-directional Infinite Scroll**:
- Scroll near top (< 200px): Loads older items (`loadMore`)
- Scroll near bottom (< 200px): Loads newer items (`loadMoreNewer`)
- Maintains scroll position during batch loading via `scrollAdjustmentRef`

### Real-Time Synchronization

Pin changes are synchronized across all clients using Server-Sent Events:

1. User pins/unpins item → POST to `/api/library/pin`
2. Server broadcasts `pin-changed` notification via `notificationService`
3. All connected clients receive notification via `/api/notifications/stream`
4. Clients trigger refresh via `useInboxNotifications` hook
5. UI updates: PinnedTags and FileCard menus refresh

**Notification Event**:
```typescript
{
  type: 'pin-changed',
  path: 'inbox/example.md',
  timestamp: '2025-01-26T10:00:00.000Z'
}
```

### UI Components

#### PinnedTags Component
**Location**: `src/components/pinned-tags.tsx`

**Props**:
- `onTagClick(path)` - Handler when tag is clicked
- `onRefresh` - Trigger value for reloading pins

**Features**:
- Fetches pinned items from `/api/inbox/pinned`
- Renders badge-style tags with Pin icon and X button
- Optimistic updates when unpinning
- Auto-refreshes when `onRefresh` prop changes
- Hidden when no pins exist

#### InboxFeed Component Updates
**Location**: `src/components/inbox-feed.tsx`

**New Props**:
- `scrollToPath` - Path to scroll to
- `onScrollComplete` - Called after scroll completes

**New Functions**:
- `loadBatchContainingItem(path)` - Loads specific batch containing item
- `loadMoreNewer()` - Loads newer items (smaller offset)
- `scrollToItem(path)` - Scrolls to item with highlight animation

**State Management**:
- `currentOffset` - Current batch offset in the full list
- `totalItems` - Total number of items
- `itemRefsRef` - Map of file paths to DOM elements

#### FileCard Context Menu
**Location**: `src/components/FileCard/file-card.tsx`

**Updates**:
- Added "Pin"/"Unpin" action to mobile menu
- Added "Pin"/"Unpin" to desktop context menu
- Uses `router.refresh()` after pin toggle
- Dynamic label based on `file.isPinned` status

### Position Query Algorithm

**Composite Sort Order**: `ORDER BY created_at DESC, path DESC`

**Position Calculation**:
1. Get target file's `created_at` timestamp
2. Count all files that come BEFORE it in sort order:
   - Files with `created_at > target.createdAt` OR
   - Files with `created_at = target.createdAt AND path > target.path`
3. Result is the 0-based position in the ordered list

**Why Composite Sort?**:
- Multiple files can have the same timestamp
- Adding `path` as secondary sort ensures stable, deterministic ordering
- No need for absolute indices - positions calculated on-demand

**Performance**:
- SQL COUNT query is efficient with indexes on `created_at` and `path`
- No need to load all items into memory
- Works for any list size

## Implementation Details

### Type System

**src/types/pin.ts**:
```typescript
export interface PinRecord {
  id: string;
  filePath: string;
  pinnedAt: string;
  displayText: string | null;
  createdAt: string;
}

export interface PinnedItem {
  path: string;
  name: string;
  pinnedAt: string;
  displayText: string;
}

export interface ItemPosition {
  position: number;
  total: number;
}
```

**src/types/file-card.ts**:
```typescript
export interface FileWithDigests {
  // ... existing fields ...
  isPinned?: boolean; // Added for pin feature
}
```

### Integration with Inbox API

**src/app/api/inbox/route.ts**:
- Calls `isPinned(file.path)` for each file in the list
- Includes `isPinned` field in response
- Efficient per-file check (no JOIN needed)

### Notification Service

**src/lib/notifications/notification-service.ts**:
- Added `'pin-changed'` to `NotificationEventType`
- Broadcasts to all connected SSE clients
- Singleton service with EventEmitter pattern

### Scroll Animation

When scrolling to a pinned item:
1. Smooth scroll: `element.scrollIntoView({ behavior: 'smooth', block: 'center' })`
2. Highlight animation: 1-second background color transition
3. Disables auto-scroll and bottom-stick behavior
4. Calls `onScrollComplete` callback after 500ms

## Edge Cases Handled

1. **Pin deleted file**: Foreign key CASCADE automatically removes pin
2. **Click already-visible pinned item**: Just scrolls, no batch loading
3. **Scroll to first/last items**: Respects boundaries (offset 0, total count)
4. **Multiple rapid pin/unpin**: Notification service handles concurrent events
5. **Nested button error**: Outer container is `<div>`, not `<button>`
6. **File position changes**: Position calculated on-demand, no stale data

## Future Enhancements

- Pin order customization (drag-and-drop reordering)
- Pin folders/tags (not just individual files)
- Pin groups/categories
- Pin limit enforcement
- Pin analytics (most accessed items)
