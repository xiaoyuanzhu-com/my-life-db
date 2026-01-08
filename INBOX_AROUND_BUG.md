# Bug: Inbox "around" Cursor Not Implemented

## Issue
The `/api/inbox?around=<cursor>` functionality is broken in the Go backend.

**Node.js implementation (WORKING):**
```typescript
if (around) {
  const cursor = parseCursor(around);
  const aroundResult = listTopLevelFilesAround("inbox/", cursor, limit);
  // Returns items centered around the cursor with targetIndex
}
```

**Go implementation (BROKEN):**
```go
if around != "" {
  cursor := db.ParseCursor(around)
  // BUG: Should call ListTopLevelFilesAround but it doesn't exist!
  result, err = db.ListTopLevelFilesNewest("inbox/", limit)
}
```

## Impact
- Pin navigation doesn't work correctly
- When clicking a pinned item, it should load the page containing that item
- Currently just loads the newest page instead

## Fix Required
Need to implement `ListTopLevelFilesAround` function in `backend/db/files.go` that:
1. Takes a cursor and finds the file
2. Loads `limit/2` items before and `limit/2` items after
3. Returns the targetIndex showing where the cursor item is in the result
4. Returns proper hasMore flags for both directions
