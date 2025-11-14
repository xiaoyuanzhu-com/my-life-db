# Search Feature Design

**Version**: 1.0
**Status**: Implementation Phase
**Last Updated**: 2025-11-14

---

## Table of Contents

1. [UX Design](#1-ux-design)
2. [Architecture](#2-architecture)
3. [Data Models](#3-data-models)
4. [Workflows](#4-workflows)
5. [API Design](#5-api-design)
6. [Ranking Strategy](#6-ranking-strategy)
7. [Implementation Phases](#7-implementation-phases)

---

## 1. UX Design

### 1.1 Always-On Passive Search

The search feature integrates seamlessly with the OmniInput component, providing instant search results without mode switching.

#### Core Principles
- **Passive search**: Results appear automatically as you type
- **Explicit adding**: "Send" button still adds items to inbox
- **No mode switching**: Search and input coexist naturally
- **Instant feedback**: Fast, responsive search experience

#### Visual Layout

```
┌─────────────────────────────────────┐
│ OmniInput (textarea)                │
│ "What's up?"                        │
│                                     │
│ [file chips]                        │
│ [+ button] [type tag] [Send button] │
└─────────────────────────────────────┘
         ↓ (appears when typing)
┌─────────────────────────────────────┐
│ Search Results                      │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ 📄 meeting-notes.md             │ │
│ │ notes/                          │ │
│ │ "Team sync about Q4 roadmap..." │ │
│ │ work, meeting • 2.4 KB          │ │
│ │ Modified 2 days ago             │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ 📝 2024-11-12.md               │ │
│ │ journal/                        │ │
│ │ "Productive day working on..."  │ │
│ │ personal, reflection • 1.8 KB   │ │
│ │ Modified 1 day ago              │ │
│ └─────────────────────────────────┘ │
│                                     │
│ Showing 2 of 47 results             │
│ [Load more]                         │
└─────────────────────────────────────┘
```

### 1.2 Adaptive Debounce Strategy

**Goal**: Balance instant search feel with typing speed and search quality.

#### Debounce Timing by Input Length

| Input Length | Debounce | Rationale |
|--------------|----------|-----------|
| 1 character  | 1000ms   | User likely still typing; single-char results not meaningful |
| 2 characters | 500ms    | User might be typing short word; results still broad |
| 3+ characters | 100ms   | Enough context for good results; fast feedback important |

#### Why Adaptive Debounce?

**Problem with Fixed Debounce:**
- Too short (e.g., 100ms): Excessive API calls, poor results for short queries
- Too long (e.g., 500ms): Feels sluggish for longer queries
- One-size-fits-all doesn't optimize for both typing speed and search quality

**Adaptive Solution:**
```
Query: "m"
↓ (User typing...)
1000ms delay → No search yet (likely typing more)

Query: "me"
↓ (User paused)
500ms delay → Search triggered (if still "me" after 500ms)

Query: "meeting"
↓ (User paused)
100ms delay → Search triggered (fast feedback)
```

#### Implementation Logic

```typescript
function getDebounceDelay(queryLength: number): number {
  if (queryLength === 0) return 0;      // No search for empty input
  if (queryLength === 1) return 1000;   // Long wait for single char
  if (queryLength === 2) return 500;    // Medium wait for two chars
  return 100;                           // Fast for 3+ chars
}
```

#### Edge Cases

**Minimum Query Length**
- Don't trigger search for empty input
- Consider skipping search for 1-char queries entirely (set debounce to Infinity)
- Show placeholder hint: "Type 2+ characters to search"

**Backspacing**
- If user backspaces from "meeting" → "me", use 500ms debounce
- Clear results immediately when input becomes empty

**Rapid Typing**
- Debounce timer resets on every keystroke
- Only search after user pauses for the specified duration
- Prevents API spam during fast typing

### 1.3 Search Result Interactions

#### Click Behavior
- **Click on card** → Navigate to file detail view (future: open viewer)
- **Cmd/Ctrl + Click** → Open in new tab (future)

#### Keyboard Navigation
- **Arrow Down/Up** → Navigate through results
- **Enter** → Open selected result
- **Esc** → Clear search and focus back to input
- **Tab** → Move focus to next interactive element

#### Loading States
- Show skeleton loaders while search is in progress
- Display search count: "Searching..." → "Found 47 results"
- Smooth transitions (fade in/out)

#### Empty States
- **No results**: "No results found for '{query}'. Try different keywords."
- **Error**: "Search temporarily unavailable. Please try again."
- **No input**: Hide search results component entirely

### 1.4 File Card Design

Each search result is displayed as a card with:

```
┌─────────────────────────────────────┐
│ 📄 {filename}                       │  ← Icon + filename
│ {folder}/                           │  ← Path (parent folder)
│ "{summary preview...}"              │  ← Summary (if available)
│ {tags} • {file size}                │  ← Tags + metadata
│ Modified {relative time}            │  ← Timestamp
└─────────────────────────────────────┘
```

**Design Constraints:**
- Minimal borders (per project preferences)
- Hover state: subtle background color change
- Selected state (keyboard nav): border highlight
- Truncate long filenames with ellipsis
- Show first 100 chars of summary

---

## 2. Architecture

### 2.1 Component Structure

```
src/
├── app/
│   ├── page.tsx                    # Main page with OmniInput
│   └── api/
│       └── search/
│           └── route.ts            # NEW: Unified search endpoint
├── components/
│   ├── OmniInput.tsx               # UPDATE: Add search trigger
│   ├── SearchResults.tsx           # NEW: Results container
│   └── SearchResultCard.tsx        # NEW: Individual result card
└── lib/
    └── search/
        └── search-service.ts       # NEW: Search orchestration
```

### 2.2 Data Flow

```
┌─────────────┐
│   User      │
│   Types     │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────┐
│  OmniInput Component            │
│  - Detect input change          │
│  - Calculate adaptive debounce  │
│  - Cancel previous search       │
└──────┬──────────────────────────┘
       │ (after debounce)
       ▼
┌─────────────────────────────────┐
│  GET /api/search?q=...          │
│  - Validate query (min 2 chars) │
│  - Search Meilisearch           │
│  - Enrich with files table      │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│  SearchResults Component        │
│  - Render result cards          │
│  - Handle interactions          │
│  - Manage pagination            │
└─────────────────────────────────┘
```

### 2.3 State Management

```typescript
// OmniInput state
interface OmniInputState {
  content: string;                  // Input text
  selectedFiles: File[];            // Uploaded files
  searchResults: SearchResult[];    // Search results
  isSearching: boolean;             // Loading state
  searchError: string | null;       // Error message
}

// Search state
interface SearchState {
  query: string;                    // Current search query
  results: SearchResult[];          // Current results
  pagination: PaginationInfo;       // Pagination state
  selectedIndex: number;            // For keyboard nav (-1 = none)
}
```

---

## 3. Data Models

### 3.1 Search Request

```typescript
interface SearchRequest {
  q: string;              // Query string (required, min 2 chars)
  limit?: number;         // Results per page (default: 20, max: 100)
  offset?: number;        // Pagination offset (default: 0)
  type?: string;          // Filter by MIME type prefix (e.g., "text/", "image/")
  path?: string;          // Filter by path prefix (e.g., "notes/", "inbox/")
}
```

**Query Parameters:**
- `q`: URL-encoded query string
- `limit`: Integer between 1 and 100
- `offset`: Integer >= 0
- `type`: MIME type or prefix
- `path`: Relative path prefix

**Example:**
```
GET /api/search?q=meeting%20notes&limit=20&offset=0&path=notes/
```

### 3.2 Search Response

```typescript
interface SearchResponse {
  results: SearchResultItem[];
  pagination: {
    total: number;        // Total matching results (from Meilisearch)
    limit: number;
    offset: number;
    hasMore: boolean;     // Whether more results are available
  };
  query: string;          // Echo back the query
  timing: {
    totalMs: number;      // Total search time
    searchMs: number;     // Meilisearch query time
    enrichMs: number;     // Data enrichment time
  };
}
```

### 3.3 Search Result Item

```typescript
interface SearchResultItem {
  // File identification (from files table)
  path: string;           // Relative path from DATA_ROOT
  name: string;           // Filename only
  mimeType: string | null;
  size: number | null;    // File size in bytes
  modifiedAt: string;     // ISO timestamp

  // Digest data (from digests table, if available)
  summary: string | null; // AI-generated summary
  tags: string | null;    // Comma-separated tags

  // Search metadata
  score: number;          // Relevance score from Meilisearch
  snippet: string;        // Text preview with match context
}
```

**Example Response:**
```json
{
  "results": [
    {
      "path": "notes/meeting-notes.md",
      "name": "meeting-notes.md",
      "mimeType": "text/markdown",
      "size": 4096,
      "modifiedAt": "2024-11-12T10:30:00Z",
      "summary": "Team sync about Q4 roadmap and priorities",
      "tags": "work, meeting, planning",
      "score": 0.95,
      "snippet": "...discussed Q4 roadmap and meeting priorities..."
    }
  ],
  "pagination": {
    "total": 47,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  },
  "query": "meeting notes",
  "timing": {
    "totalMs": 145,
    "searchMs": 42,
    "enrichMs": 103
  }
}
```

---

## 4. Workflows

### 4.1 Search Flow

```
1. User types in OmniInput
   ↓
2. Calculate adaptive debounce delay based on query length
   ↓
3. Wait for debounce period (timer resets on each keystroke)
   ↓
4. Timer expires → Trigger search
   ↓
5. Show loading state (skeleton cards)
   ↓
6. Call GET /api/search?q={query}
   ↓
7. Receive results
   ↓
8. Render SearchResults component with cards
   ↓
9. User can interact with results or continue typing
```

### 4.2 Pagination Flow

```
1. Initial search returns first 20 results
   ↓
2. User scrolls to bottom, clicks "Load More"
   ↓
3. Call GET /api/search?q={query}&offset=20
   ↓
4. Append new results to existing list
   ↓
5. Repeat until hasMore = false
```

### 4.3 Result Interaction Flow

```
User clicks on result card
   ↓
Navigate to /files/{encoded-path}
   ↓
Show file detail view with:
   - Full content
   - All digests
   - Edit/delete actions
```

---

## 5. API Design

### 5.1 Endpoint Specification

**Endpoint:** `GET /api/search`

**Method:** GET (supports caching, bookmarking)

**Authentication:** None (future: session-based auth)

**Rate Limiting:** 60 requests/minute per session (future)

### 5.2 Request Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | Yes | - | Search query (min 2 chars) |
| `limit` | number | No | 20 | Results per page (max 100) |
| `offset` | number | No | 0 | Pagination offset |
| `type` | string | No | - | MIME type filter (prefix match) |
| `path` | string | No | - | Path prefix filter |

**Validation Rules:**
- `q`: Length between 2 and 200 characters
- `limit`: Integer between 1 and 100
- `offset`: Integer >= 0
- `type`: Valid MIME type format
- `path`: Valid relative path (no `..` or absolute paths)

### 5.3 Response Codes

| Code | Meaning | Description |
|------|---------|-------------|
| 200 | Success | Results returned (may be empty array) |
| 400 | Bad Request | Invalid parameters (e.g., query too short) |
| 500 | Server Error | Search service unavailable |

### 5.4 Error Response

```typescript
interface ErrorResponse {
  error: string;          // Error message
  details?: string;       // Additional details (dev mode only)
  code?: string;          // Error code for client handling
}
```

**Example:**
```json
{
  "error": "Query must be at least 2 characters",
  "code": "QUERY_TOO_SHORT"
}
```

---

## 6. Ranking Strategy

### 6.1 Phase 1: Meilisearch Only

**Current Implementation:**
- Use Meilisearch's built-in relevance ranking
- Searches across indexed fields: `content`, `summary`, `tags`, `filePath`
- Returns results sorted by relevance score (BM25 algorithm)

**Ranking Factors (Meilisearch):**
1. **Term frequency**: How often query terms appear in document
2. **Field weights**: Matches in `summary` > `tags` > `content` > `filePath`
3. **Position**: Earlier matches ranked higher
4. **Typo tolerance**: Handles misspellings (1-2 char edits)
5. **Proximity**: Terms appearing close together ranked higher

**Configuration:**
```typescript
// Meilisearch index settings
{
  searchableAttributes: [
    'summary',      // Highest priority
    'tags',
    'content',
    'filePath'
  ],
  rankingRules: [
    'words',        // Number of matching query terms
    'typo',         // Typo tolerance
    'proximity',    // Term proximity
    'attribute',    // Field weight
    'sort',         // Custom sorting (future)
    'exactness'     // Exact matches
  ]
}
```

### 6.2 Phase 2: Hybrid Search (Future)

**Planned Enhancement:**
- Combine Meilisearch (keyword) + Qdrant (semantic)
- Use Reciprocal Rank Fusion (RRF) to merge results
- Formula: `score = keywordWeight/(k+rank) + semanticWeight/(k+rank)`
- Where `k=60`, `keywordWeight=0.6`, `semanticWeight=0.4`

**Benefits:**
- Find conceptually similar content (not just keyword matches)
- Better handling of synonyms and paraphrases
- More robust for natural language queries

### 6.3 Future Enhancements

**Recency Boost:**
```typescript
const ageInDays = (Date.now() - new Date(file.modifiedAt)) / (1000 * 60 * 60 * 24);
const recencyBoost = Math.exp(-ageInDays / 30); // Decay over 30 days
finalScore = baseScore * (1 + 0.2 * recencyBoost);
```

**Click Tracking:**
- Log which results users click on
- Use implicit feedback to adjust ranking weights
- Personalize results over time

**Query Understanding:**
- Parse special syntax: `tag:work`, `type:pdf`, `date:2024-11`
- Auto-suggest corrections for misspellings
- Expand synonyms (e.g., "note" → "note, memo, journal")

---

## 7. Implementation Phases

### Phase 1: MVP (Current)
- [x] Design document
- [ ] `/api/search` endpoint with Meilisearch
- [ ] Adaptive debounce in OmniInput
- [ ] SearchResults component with file cards
- [ ] Basic keyboard navigation

**Success Criteria:**
- Search returns results in < 500ms (p95)
- Adaptive debounce feels responsive
- Results display file metadata correctly

### Phase 2: Enhanced UX
- [ ] Infinite scroll pagination
- [ ] Result highlighting (match terms in bold)
- [ ] File type icons
- [ ] Click to open file detail view
- [ ] Loading skeletons and error states

**Success Criteria:**
- Pagination works smoothly
- Visual polish matches design mockups
- Error handling is user-friendly

### Phase 3: Advanced Features
- [ ] Hybrid search with Qdrant (semantic)
- [ ] Query syntax parsing (`tag:work type:pdf`)
- [ ] Filter UI (date range, file type, tags)
- [ ] Search history and suggestions
- [ ] Keyboard shortcut (Cmd+K to focus)

**Success Criteria:**
- Hybrid search improves relevance measurably
- Advanced filters work correctly
- Power users adopt keyboard shortcuts

### Phase 4: Optimization
- [ ] Query result caching (Redis or in-memory)
- [ ] Recency boosting
- [ ] Click tracking and relevance feedback
- [ ] Performance monitoring and alerting
- [ ] Search analytics dashboard

**Success Criteria:**
- Cached queries return in < 50ms
- Click-through rate > 70%
- Search usage > 40% of all navigation

---

## Appendix: Technical Considerations

### Performance
- **Debouncing**: Adaptive timing balances responsiveness and API load
- **Caching**: Browser caches GET responses for 5 minutes
- **Pagination**: Load More instead of infinite scroll (simpler, more control)
- **Lazy Loading**: Only fetch file details on card expand (future)

### Security
- **Input Validation**: Sanitize query to prevent injection (Meilisearch escapes automatically)
- **Rate Limiting**: 60 requests/minute per session (future)
- **Content Security**: Only return file metadata, not full content (privacy)
- **Path Traversal**: Reject queries with `..` or absolute paths

### Accessibility
- **Keyboard Navigation**: Full support with arrow keys, enter, escape
- **ARIA Labels**: Proper labeling for screen readers
- **Focus Management**: Clear focus indicators, logical tab order
- **Status Messages**: Announce "X results found" to screen readers
- **Color Contrast**: Ensure text meets WCAG AA standards

### Mobile UX
- **Touch Targets**: Minimum 44px for cards and buttons
- **Responsive Layout**: Stack cards vertically, full width on mobile
- **Scroll Behavior**: Native smooth scrolling, pull-to-refresh
- **Performance**: Optimize for 3G networks (smaller payloads, aggressive caching)

---

## Open Questions

1. **Should single-character queries trigger search?**
   - Current: No (1000ms debounce, effectively disabled)
   - Alternative: Skip entirely, show hint "Type 2+ characters"
   - **Decision Needed**: UX preference

2. **What happens on search error?**
   - Show error message in results area
   - Retry automatically (1 retry after 2s)?
   - Fall back to cached results?
   - **Decision Needed**: Error handling strategy

3. **Should results persist after adding an item?**
   - Option A: Clear search on submit (clean slate)
   - Option B: Keep results (useful for multiple adds)
   - **Decision Needed**: User workflow preference

4. **Max pagination depth?**
   - Current: Unlimited (paginate through all results)
   - Alternative: Cap at 200 results, suggest refining query
   - **Decision Needed**: Performance vs completeness tradeoff

---

## Success Metrics

### MVP Goals
- **Search Latency**: p95 < 500ms for keyword search
- **Result Relevance**: Top 5 results include user's target 80%+ of the time
- **Adoption**: 60%+ of users try search within first week
- **Usability**: Users find files without explicit instructions

### Long-Term Goals
- **Search Usage**: 40%+ of navigation via search (vs browsing folders)
- **Click-Through Rate**: 70%+ of searches result in clicking a result
- **Refinement Rate**: < 30% of searches need query refinement
- **Performance**: p95 latency < 300ms with caching
