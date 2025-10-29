# Task Queue (Inbox System)

## Overview

The Task Queue (internally called the Inbox System) is a temporary staging area for content before processing and organization. It provides a queuing mechanism for managing items with different processing states, allowing users to track and manage content as it moves through various stages.

## Features

- **Multiple Queue Views**: Items are organized into queues based on their processing status
- **Expandable UI**: Each queue can be expanded/collapsed to view items
- **Pagination**: Large queues display items in pages (10 items per page) with navigation controls
- **Status Tracking**: Four distinct processing states for items
- **Detailed Item View**: Each item displays files, metadata, timestamps, and processing details
- **File Management**: Support for multiple file types with type indicators and size information

## Queue Types

The system organizes items into four queues based on their processing status:

### 1. Pending Queue (Yellow)
- Items awaiting processing
- Default state for newly created items
- Ready to be picked up by processing workers

### 2. Processing Queue (Blue)
- Items currently being processed
- Processing may include AI analysis, content extraction, or organization
- Intermediate state before completion or failure

### 3. Completed Queue (Green)
- Items that have been successfully processed
- Ready for organization into the library
- May include AI-generated metadata like slugs

### 4. Failed Queue (Red)
- Items that encountered errors during processing
- Displays error messages for debugging
- Can be retried or manually reviewed

## User Interface

### Queue List View
- Expandable accordion-style interface
- Each queue displays the total count of items
- Color-coded badges indicate queue type
- Queues can be expanded independently

### Item Cards
Each item in a queue displays:
- **Folder Name**: Unique identifier (UUID or AI-generated slug)
- **Type Badge**: Content type (text, url, image, audio, video, pdf, mixed)
- **Timestamp**: Creation date and time
- **Files Section**: List of all associated files with:
  - File type icon
  - Filename
  - File size in KB
- **Additional Details**:
  - Processed timestamp (when applicable)
  - AI-generated slug (when available)
  - Error messages (for failed items)
- **Actions**: Delete button for removing items

### Pagination
- Automatically displayed when a queue has more than 10 items
- Previous/Next navigation buttons
- Direct page number selection
- Independent pagination state per queue

## Technical Implementation

### Data Structure

```typescript
interface InboxItem {
  id: string;                           // UUID
  folderName: string;                   // Folder identifier
  type: MessageType;                    // Content type
  files: InboxFile[];                   // Array of files
  status: ProcessingStatus;             // Queue status
  processedAt: string | null;           // Processing timestamp
  error: string | null;                 // Error message
  aiSlug: string | null;                // AI-generated slug
  schemaVersion: number;                // Metadata version
  createdAt: string;                    // Creation timestamp
  updatedAt: string;                    // Last update timestamp
}

type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed';
type MessageType = 'text' | 'url' | 'image' | 'audio' | 'video' | 'pdf' | 'mixed';
```

### API Endpoints

#### List Items
```
GET /api/inbox
Query Parameters:
  - status (optional): Filter by processing status
  - limit (optional): Max items to return (default: 50)
  - offset (optional): Pagination offset (default: 0)
Response:
  { items: InboxItem[], total: number }
```

#### Create Item
```
POST /api/inbox
Body: FormData
  - text (optional): Text content
  - files (optional): File uploads
Response: InboxItem (status 201)
```

#### Get Single Item
```
GET /api/inbox/[id]
Response: InboxItem or 404
```

#### Update Item
```
PUT /api/inbox/[id]
Body: FormData
  - text (optional): Update text content
  - files (optional): Add new files
  - removeFiles (optional): Array of filenames to delete
Response: Updated InboxItem
```

#### Delete Item
```
DELETE /api/inbox/[id]
Response: { success: boolean }
```

### Database Schema

```sql
CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  folder_name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  files TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  processed_at TEXT,
  error TEXT,
  ai_slug TEXT,
  schema_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### File Storage

Files are stored in the filesystem at:
```
MY_DATA_DIR/.app/mylifedb/inbox/[folder-name]/
```

Each item has its own folder containing:
- `text.md` - User's text input (if provided)
- Additional uploaded files

## UI Components

The task queue UI uses the following shadcn/ui components:
- **Accordion**: For expandable queue sections
- **Card**: For item display
- **Pagination**: For navigating through items
- **Button**: For actions and navigation

### Component Structure
```
src/app/inbox/page.tsx           # Main task queue page
src/components/ui/accordion.tsx  # Accordion component
src/components/ui/pagination.tsx # Pagination component
src/components/ui/Card.tsx       # Card component
```

## Usage Examples

### Viewing Queues
1. Navigate to the Inbox/Task Queue page
2. View the count of items in each queue
3. Click on a queue to expand and view items

### Managing Items
1. Expand a queue to view items
2. Review item details, files, and status
3. Use pagination to navigate through multiple pages
4. Delete items that are no longer needed

### Monitoring Processing
1. Check the Processing queue for active items
2. Review the Completed queue for successful items
3. Investigate the Failed queue for errors
4. Monitor timestamps to track processing time

## Best Practices

1. **Regular Cleanup**: Periodically review and delete completed items
2. **Error Monitoring**: Check the Failed queue regularly for processing issues
3. **Status Tracking**: Use status filters in API calls for targeted queries
4. **Pagination**: Keep queue sizes manageable for better performance

## Future Enhancements

Potential improvements to the task queue system:
- Auto-refresh for real-time status updates
- Bulk operations (delete, retry, move)
- Search and filter within queues
- Detailed processing logs
- Queue-specific settings and thresholds
- Export functionality for queue data
- Retry mechanism for failed items
- Manual status transitions

## Related Documentation

- [Database Module README](../src/lib/db/README.md)
- [Technical Design](./tech-design.md)
- [Product Design](./product-design.md)
