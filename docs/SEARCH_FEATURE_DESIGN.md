# Search Feature Design

**Status**: Design Phase
**Date**: 2025-11-14
**Goal**: Implement instant search UX with hybrid search capabilities

## Overview

This document outlines the design for implementing a search feature in MyLifeDB. The search will integrate seamlessly with the existing OmniInput component, providing instant search results while maintaining the ability to add new items.

---

## 1. Omnibox UX Design

### Current State
- OmniInput serves as the primary input mechanism for adding items
- Located prominently on the home page (vertically centered)
- Supports text input, file uploads, and input type detection
- Submits to `/api/inbox` to create new items

### Proposed UX: **Always-On Passive Search**

The omnibox will serve dual purposes without explicit mode switching:

#### Behavior
1. **Search is passive and always-on**
   - As user types, search results appear below the input in real-time
   - Debounced search (300-500ms) to avoid excessive API calls
   - No need to switch modes or press special keys

2. **Adding items remains explicit**
   - "Send" button (or Cmd+Enter) explicitly adds the item to inbox
   - Search results don't interfere with the add workflow
   - Clear visual separation between search results and input controls

3. **Visual Layout**
   ```
   ┌─────────────────────────────────────┐
   │ OmniInput (textarea)                │
   │ "What's up?"                        │
   │                                     │
   │ [file chips]                        │
   │ [+ button] [type tag] [Send button] │
   └─────────────────────────────────────┘

   ┌─────────────────────────────────────┐
   │ Search Results (appears on typing)  │
   │                                     │
   │ ┌─────────────────────────────────┐ │
   │ │ 📄 notes/meeting-notes.md       │ │
   │ │ "Team sync about Q4 roadmap..." │ │
   │ │ tags: work, meeting             │ │
   │ └─────────────────────────────────┘ │
   │                                     │
   │ ┌─────────────────────────────────┐ │
   │ │ 📝 journal/2024-11-12.md       │ │
   │ │ "Productive day working on..." │ │
   │ │ tags: personal, reflection     │ │
   │ └─────────────────────────────────┘ │
   │                                     │
   │ Showing 2 of 47 results             │
   │ [Load more]                         │
   └─────────────────────────────────────┘
   ```

#### Edge Cases & Interaction Details

**Empty State**
- No search results shown when input is empty
- Original centered layout remains clean

**Search Results Interaction**
- Click on result → Navigate to detail view (future: open file viewer)
- Hover → Highlight result
- Keyboard navigation: Arrow keys to navigate, Enter to open
- Esc → Clear search / focus back to input

**Adding vs Searching**
- Typing "buy groceries" → Shows search results
- Press Send → Adds "buy groceries" to inbox (search results don't interfere)
- Clear distinction: passive search, explicit add

**Minimum Query Length**
- Don't search for queries < 2 characters (avoid noise)
- Show "Type to search..." hint when input is short

**Loading States**
- Show skeleton loaders while search is in progress
- Debounce ensures smooth typing experience

---

## 2. Search API Architecture

### Current Implementation
We already have `/api/search/hybrid` implemented with:
- Parallel search across Meilisearch (keyword) and Qdrant (semantic)
- Reciprocal Rank Fusion (RRF) for merging results
- Filtering by `mimeType` and `filePath`
- Configurable weights and score thresholds

### Proposed Unified API: `/api/search`

Create a new simplified endpoint that wraps the hybrid search for frontend use:

#### Endpoint
```
GET /api/search?q={query}&limit={limit}&offset={offset}&type={type}
```

#### Request Parameters
```typescript
interface SearchRequest {
  q: string;              // Query string (required, min 2 chars)
  limit?: number;         // Results per page (default: 20, max: 100)
  offset?: number;        // Pagination offset (default: 0)
  type?: string;          // Filter by MIME type prefix (e.g., "text/", "image/")
  path?: string;          // Filter by path prefix (e.g., "notes/", "inbox/")
}
```

#### Response Format
```typescript
interface SearchResponse {
  results: SearchResultItem[];
  pagination: {
    total: number;        // Total matching results (approximate for hybrid)
    limit: number;
    offset: number;
    hasMore: boolean;     // Whether more results are available
  };
  query: string;          // Echo back the query
  timing: {
    totalMs: number;      // Total search time
    keywordMs?: number;
    semanticMs?: number;
  };
}

interface SearchResultItem {
  // File identification (from files table)
  path: string;           // Relative path from DATA_ROOT
  name: string;           // Filename only
  mimeType: string | null;
  size: number | null;
  modifiedAt: string;     // ISO timestamp

  // Digest data (from digests table, if available)
  summary: string | null; // AI-generated summary
  tags: string | null;    // Comma-separated tags

  // Search metadata
  score: number;          // Hybrid relevance score (0-1)
  snippet: string;        // Highlighted text snippet showing match
  matchType: 'keyword' | 'semantic' | 'hybrid'; // Which search found it
}
```

### Why a Separate `/api/search` Endpoint?

1. **Simpler Frontend Contract**
   - GET request with query params (easier for caching, bookmarking)
   - Unified interface instead of choosing between keyword/semantic/hybrid
   - Frontend doesn't need to know about RRF weights, score thresholds, etc.

2. **Better Defaults**
   - Can set smart defaults for instant search (balanced weights, reasonable thresholds)
   - Easy to add query preprocessing (stemming, synonym expansion, etc.)

3. **Future Extensibility**
   - Can add query parsing (e.g., "tag:work type:pdf")
   - Can add smart routing (use keyword-only for very short queries)
   - Can add result deduplication, grouping, or enrichment

4. **Performance Optimization**
   - Can cache common queries
   - Can implement query suggestion/autocomplete in same endpoint
   - Can add telemetry for improving search relevance

### Implementation Plan

The `/api/search` endpoint will:
1. Parse and validate query parameters
2. Build `HybridSearchRequest` with smart defaults:
   - `keywordWeight: 0.6` (keyword slightly favored for instant search)
   - `semanticWeight: 0.4` (semantic for broader matching)
   - `scoreThreshold: 0.65` (filter low-quality semantic matches)
3. Call existing `/api/search/hybrid` internally (or import the function)
4. Enrich results with file metadata from `files` table
5. Generate snippets with match highlighting
6. Return paginated response

---

## 3. Hybrid Search Strategy

### Current Implementation: Reciprocal Rank Fusion (RRF)

The existing `/api/search/hybrid` already implements RRF correctly:

```typescript
// RRF formula: score = sum(weight / (k + rank))
// where k = 60 (constant to prevent division by zero)

function reciprocalRankFusion(
  keywordResults: KeywordSearchResult[],
  semanticResults: SemanticSearchHit[],
  keywordWeight: number,
  semanticWeight: number
): HybridSearchResult[]
```

**How RRF Works:**
1. Each search backend returns ranked results
2. For each result at rank `i`, compute: `score = weight / (k + i + 1)`
3. If a document appears in both lists, scores are summed
4. Final results sorted by combined score (descending)

**Example:**
```
Query: "meeting notes Q4"

Keyword Results:
1. notes/meeting-notes.md    → RRF score: 0.6/(60+1) = 0.0098
2. work/q4-planning.md       → RRF score: 0.6/(60+2) = 0.0097

Semantic Results:
1. work/q4-planning.md       → RRF score: 0.4/(60+1) = 0.0066
2. notes/standup-log.md      → RRF score: 0.4/(60+2) = 0.0065

Merged (sorted by total score):
1. work/q4-planning.md       → Total: 0.0097 + 0.0066 = 0.0163 ✓ (in both)
2. notes/meeting-notes.md    → Total: 0.0098 (keyword only)
3. notes/standup-log.md      → Total: 0.0065 (semantic only)
```

### Advantages of RRF
- **Rank-based**: Works without normalizing scores across different search systems
- **Simple**: No need to tune score normalization constants
- **Fair**: Prevents one search backend from dominating
- **Robust**: Well-tested in production search systems

### Proposed Refinements

**1. Adaptive Weighting (Future Enhancement)**
```typescript
// For very short queries (< 5 words), favor keyword search
const queryLength = query.split(/\s+/).length;
const keywordWeight = queryLength < 5 ? 0.7 : 0.5;
const semanticWeight = 1 - keywordWeight;
```

**2. Boost Recent Files (Future Enhancement)**
```typescript
// Apply recency boost to score
const ageInDays = (Date.now() - new Date(file.modifiedAt)) / (1000 * 60 * 60 * 24);
const recencyBoost = Math.exp(-ageInDays / 30); // Decay over 30 days
finalScore = hybridScore * (1 + 0.2 * recencyBoost);
```

**3. User Feedback Loop (Future Enhancement)**
- Track which results users click on
- Use implicit feedback to tune weights over time
- Personalize search ranking per user

---

## 4. Pagination Strategy

### Challenge with Hybrid Search

Traditional offset-based pagination doesn't work well with hybrid search:

```
Problem:
- Page 1: Fetch 20 from keyword, 20 from semantic → merge → return top 20
- Page 2: Fetch 20 more from each → merge → ???
  - Results on page 2 might have higher scores than page 1!
  - Inconsistent results if data changes between requests
```

### Proposed Solution: **Over-Fetch and Slice**

For instant search with reasonable page sizes, we can over-fetch from backends:

#### Strategy
```typescript
// Frontend requests page 2 (offset=20, limit=20)
const requestedOffset = 20;
const requestedLimit = 20;

// Backend over-fetches from both search systems
const backendLimit = requestedOffset + requestedLimit + 40; // Fetch extra buffer
const keywordResults = await meili.search(query, { limit: backendLimit });
const semanticResults = await qdrant.search(query, { limit: backendLimit });

// Merge all results with RRF
const mergedResults = reciprocalRankFusion(
  keywordResults,
  semanticResults,
  keywordWeight,
  semanticWeight
);

// Slice the requested page
const pageResults = mergedResults.slice(requestedOffset, requestedOffset + requestedLimit);

return {
  results: pageResults,
  pagination: {
    total: Math.max(keywordResults.length, semanticResults.length), // Approximate
    offset: requestedOffset,
    limit: requestedLimit,
    hasMore: mergedResults.length > (requestedOffset + requestedLimit)
  }
};
```

#### Tradeoffs

**Advantages:**
- Simple to implement
- Works with existing RRF implementation
- Consistent results within a reasonable pagination depth
- Good enough for instant search use cases

**Disadvantages:**
- Over-fetching increases latency for later pages
- Total count is approximate
- Not suitable for deep pagination (100+ pages)

**Practical Limits:**
- Works well for first 5-10 pages (100-200 results)
- For instant search, users rarely go beyond 3-4 pages
- Can set a hard limit (e.g., max 500 results) to cap over-fetching

#### Alternative: Cursor-Based Pagination (Future)

For deep pagination, we could implement cursor-based pagination:

```typescript
interface SearchRequest {
  q: string;
  limit?: number;
  cursor?: string; // Opaque cursor encoding last seen scores
}

interface SearchResponse {
  results: SearchResultItem[];
  nextCursor?: string; // Cursor for next page
}
```

This requires:
- Storing search state (last seen scores from each backend)
- More complex backend logic
- Not necessary for MVP instant search

### Recommendation

**For MVP**: Use over-fetch strategy with these limits:
- Max offset: 200 (10 pages × 20 results)
- Max backend fetch: 300 results per system
- Show "Refine your search" message if user hits the limit

**For Future**: Implement cursor-based pagination if users need deep search exploration.

---

## 5. Implementation Phases

### Phase 1: Basic Instant Search (MVP)
- [ ] Create `/api/search` GET endpoint wrapping hybrid search
- [ ] Add search results component below OmniInput
- [ ] Implement debounced search (500ms)
- [ ] Display results with file metadata (name, path, modified date)
- [ ] Basic pagination (Load More button)
- [ ] Keyboard navigation (arrow keys, enter to open)

### Phase 2: Enhanced Results
- [ ] Add snippet generation with match highlighting
- [ ] Display digest data (summary, tags) if available
- [ ] Show file type icons
- [ ] Add file size and modified date
- [ ] Implement infinite scroll pagination

### Phase 3: Advanced Features
- [ ] Query syntax parsing (e.g., `tag:work type:pdf`)
- [ ] Filter UI (by type, date range, tags)
- [ ] Search history and suggestions
- [ ] Keyboard shortcuts (Cmd+K to focus search)
- [ ] Result preview on hover

### Phase 4: Optimization
- [ ] Query result caching
- [ ] Adaptive weight tuning based on query
- [ ] Recency boosting
- [ ] Click tracking and relevance feedback
- [ ] Performance monitoring and optimization

---

## 6. Technical Considerations

### Performance
- **Debouncing**: 300-500ms to balance responsiveness and API load
- **Caching**: Cache search results in browser for 5 minutes
- **Lazy Loading**: Only load result details on hover/expand
- **Progressive Enhancement**: Show fast keyword results first, enhance with semantic

### Security
- **Input Validation**: Sanitize query to prevent injection attacks (already implemented)
- **Rate Limiting**: Limit search API to 60 requests/minute per session
- **Content Security**: Don't expose file contents in search results (only snippets)

### Accessibility
- **Keyboard Navigation**: Full keyboard support for search results
- **ARIA Labels**: Proper labeling for screen readers
- **Focus Management**: Clear focus indicators, logical tab order
- **Status Messages**: Announce search results to screen readers

### Mobile UX
- **Touch Targets**: Minimum 44px touch targets for results
- **Scroll Behavior**: Smooth scrolling, pull-to-refresh support
- **Responsive Layout**: Stack results vertically on mobile
- **Performance**: Optimize for slower mobile connections

---

## 7. Data Flow Diagram

```
┌─────────────┐
│   User      │
│   Types     │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────┐
│  OmniInput Component            │
│  - Debounce (500ms)             │
│  - Show loading state           │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│  GET /api/search?q=...          │
│  - Validate query               │
│  - Build HybridSearchRequest    │
└──────┬──────────────────────────┘
       │
       ├────────────┬──────────────┐
       ▼            ▼              ▼
  ┌─────────┐  ┌─────────┐   ┌─────────┐
  │ Meili   │  │ Qdrant  │   │  Files  │
  │ Search  │  │ Search  │   │  Table  │
  └────┬────┘  └────┬────┘   └────┬────┘
       │            │              │
       └────────────┴──────────────┘
                    │
                    ▼
       ┌────────────────────────┐
       │  Reciprocal Rank       │
       │  Fusion (RRF)          │
       │  - Merge results       │
       │  - Sort by score       │
       └──────┬─────────────────┘
              │
              ▼
       ┌────────────────────────┐
       │  Enrich Results        │
       │  - Add file metadata   │
       │  - Generate snippets   │
       │  - Add digest data     │
       └──────┬─────────────────┘
              │
              ▼
       ┌────────────────────────┐
       │  Paginate & Return     │
       │  - Slice requested page│
       │  - Build pagination    │
       └──────┬─────────────────┘
              │
              ▼
       ┌────────────────────────┐
       │  SearchResults         │
       │  Component             │
       │  - Render results      │
       │  - Handle interactions │
       └────────────────────────┘
```

---

## 8. Open Questions

### UX Questions
1. **Should search results persist after adding an item?**
   - Option A: Clear search on submit (clean slate)
   - Option B: Keep search results (useful for multiple adds)
   - **Recommendation**: Clear search on submit (matches mental model)

2. **What happens when user has files selected + types search query?**
   - Option A: Search applies to query only, files remain for adding
   - Option B: Files influence search (e.g., "find similar to this file")
   - **Recommendation**: Option A (keep separate)

3. **Should we show "Add to inbox" button in search results?**
   - Could allow quick capture of URLs/bookmarks found in search
   - **Recommendation**: Not in MVP, add later if needed

### Technical Questions
1. **Should we index inbox files?**
   - Pro: Can search everything including unprocessed items
   - Con: Inbox items might not have good metadata yet
   - **Recommendation**: Index inbox after digest is generated

2. **How to handle very large result sets (10,000+ matches)?**
   - Current: Over-fetch strategy breaks down
   - **Recommendation**: Add "too many results" message, suggest refining query

3. **Should we cache query embeddings?**
   - Could speed up semantic search for common queries
   - **Recommendation**: Yes, add Redis cache for embeddings (future optimization)

---

## 9. Success Metrics

### MVP Goals
- **Search Latency**: p95 < 500ms for hybrid search
- **Result Relevance**: Top 5 results should include user's target 80%+ of the time
- **User Engagement**: 60%+ of users try search within first week
- **Usability**: Users can find files without explicit mode switching

### Future Goals
- **Search Usage**: 40%+ of navigation happens via search (vs browsing)
- **Click-Through Rate**: 70%+ of searches result in clicking a result
- **Refinement Rate**: < 30% of searches need query refinement
- **Performance**: p95 latency < 300ms with caching

---

## Appendix: File Structure

```
src/
├── app/
│   ├── api/
│   │   └── search/
│   │       ├── route.ts           # NEW: Unified search endpoint
│   │       ├── hybrid/
│   │       │   └── route.ts       # Existing: Hybrid search
│   │       ├── keyword/
│   │       │   └── route.ts       # Existing: Keyword search
│   │       └── semantic/
│   │           └── route.ts       # Existing: Semantic search
│   └── page.tsx                   # Update: Add SearchResults
├── components/
│   ├── OmniInput.tsx              # Update: Add search trigger
│   └── SearchResults.tsx          # NEW: Search results display
└── lib/
    └── search/
        ├── unified-search.ts      # NEW: Search orchestration
        └── snippet-generator.ts   # NEW: Snippet with highlighting
```
