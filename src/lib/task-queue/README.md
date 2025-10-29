# Task Queue System Specification

**Version:** 1.0
**Type:** Language-agnostic, Database-agnostic
**Purpose:** Specification for implementing a production-ready task queue in any language/database

> **What is this?** This is a complete specification that any coding agent or developer can use to implement a task queue system in their preferred technology stack. It defines features, interfaces, data models, and API contracts without prescribing implementation details.

## Table of Contents

1. [Features](#1-features)
2. [Interface Contracts](#2-interface-contracts)
3. [Data Models](#3-data-models)
4. [Core Modules](#4-core-modules)
5. [API Specification](#5-api-specification)
6. [UI Components](#6-ui-components)
7. [Reference Implementation](#7-reference-implementation)
8. [Integration Guide](#8-integration-guide)

---

## 1. Features

### 1.1 Core Features

- ✅ **Task Enqueue**: Add tasks to queue with arbitrary JSON payload
- ✅ **Automatic Retry**: Failed tasks retry with exponential backoff
- ✅ **Exactly-Once Execution**: Tasks executed once via optimistic locking (see 4.3)
- ✅ **Timeout Protection**: Auto-recover stale tasks after timeout
- ✅ **Future Scheduling**: Schedule tasks to run at specific time
- ✅ **Manual Retry**: Force retry of failed tasks
- ✅ **Task Deletion**: Delete completed/failed tasks
- ✅ **Cleanup**: Bulk delete old completed tasks
- ✅ **Background Worker**: Automatic polling and processing
- ✅ **Batch Processing**: Process multiple tasks per poll
- ✅ **RPS Control**: Limit execution rate (tasks per second)
- ✅ **Parallelism Control**: Control concurrent task execution
- ✅ **Worker Pause/Resume**: Pause worker without stopping it
- ✅ **Observability**: Status tracking, error logging, result storage, statistics, query API

### 1.2 Non-Features (Out of Scope)

- ❌ **Priority scheduling**: Tasks processed in FIFO order
- ❌ **Task cancellation**: Adds complexity, can just wait or delete
- ❌ **Idempotency keys**: Perf-heavy, handle at application level
- ❌ **Task dependencies**: Run B after A completes
- ❌ **Progress tracking**: 0-100% completion
- ❌ **Distributed locking**: Multi-server coordination (single-DB only)
- ❌ **Dead letter queue**: Failed tasks stay in main table

### 1.3 Design Rationale

**Why Exactly-Once?**
- **Problem**: Concurrent workers may pick same task
- **Solution**: Optimistic locking with row versioning
- **Cost**: One extra column (`version`), minimal performance impact
- **Complexity**: Low - just check version in UPDATE WHERE clause

**Why Timeout Protection?**
- **Problem**: Worker crashes while processing → task stuck in 'processing' forever
- **Solution**: Auto-recover tasks in 'processing' state for > timeout duration
- **Default**: 5 minutes (configurable)
- **Mechanism**: Worker polls for stale tasks and resets to 'pending'

**Why No Handler Timeout Enforcement?**
- **Rationale**:
  - Handlers are user code (can't reliably kill threads/processes)
  - Different handlers have different needs (30s vs 5min vs 1hr)
  - Handler should implement its own timeout logic
  - Worker timeout protects against crashes, not slow handlers
- **Recommendation**: Handlers should fail fast or implement internal timeout

---

## 2. Interface Contracts

### 2.1 Task Handler Interface

**Purpose:** User-defined function that executes a task

**Contract:**
```
Input:  JSON payload (application-defined)
Output: JSON result (optional) OR Error
```

**Pseudocode:**
```
function TaskHandler(payload: JSON): JSON | Error {
  // User implementation
  // Throw/return error to mark task as failed
  // Return result to mark task as completed
}
```

**Examples:**
```javascript
// JavaScript
async function handleEmailSend(payload) {
  await sendEmail(payload.to, payload.subject, payload.body);
  return { messageId: "abc123" };
}
```

```python
# Python
def handle_email_send(payload):
    send_email(payload["to"], payload["subject"], payload["body"])
    return {"message_id": "abc123"}
```

```go
// Go
func HandleEmailSend(payload map[string]interface{}) (map[string]interface{}, error) {
    err := sendEmail(payload["to"], payload["subject"], payload["body"])
    if err != nil {
        return nil, err
    }
    return map[string]interface{}{"message_id": "abc123"}, nil
}
```

### 2.2 Queue Interface (Application-Level)

**Purpose:** Simple, ergonomic API for application code

**Primary Interface (Task-Type Scoped):**

```javascript
// Access task type context (chainable)
tq(type: String): TaskTypeContext

// TaskTypeContext methods (all chainable)
.add(payload: JSON, options?: EnqueueOptions): TaskTypeContext
.setWorker(handler: Function): TaskTypeContext
.setWorkerCount(count: Number): TaskTypeContext     // Parallelism for this type
.setRateLimit(tasksPerSecond: Number): TaskTypeContext
.setTimeout(seconds: Number): TaskTypeContext        // Task timeout for this type
```

**Example Usage:**

```javascript
// Setup worker
tq('crawl')
  .setWorker(async (payload) => {
    console.log('Crawling', payload.url);
    await fetch(payload.url);
  })
  .setWorkerCount(3)
  .setRateLimit(10)      // 10 tasks/sec for crawl type
  .setTimeout(300);      // 5 min timeout for crawl tasks

// Enqueue tasks
tq('crawl').add({ url: 'https://www.google.com/' });
tq('crawl').add({ url: 'https://www.baidu.com/' });

// Can also chain adds
tq('crawl')
  .add({ url: 'https://example.com/1' })
  .add({ url: 'https://example.com/2' })
  .add({ url: 'https://example.com/3' });

// Different task types, different configs
tq('email')
  .setWorker(async (payload) => await sendEmail(payload))
  .setWorkerCount(1)     // Sequential
  .setRateLimit(5);      // 5 emails/sec

tq('email').add({ to: 'user@example.com', subject: 'Hello' });
```

**Global Worker Control:**

```javascript
// Pause/resume ALL workers
tq.pause();
tq.resume();

// Get global stats
tq.stats();  // Returns QueueStats

// Graceful shutdown
await tq.stop();
```

**TypeScript Support:**

```typescript
// Type-safe payloads
interface CrawlPayload {
  url: string;
  depth?: number;
}

tq<CrawlPayload>('crawl')
  .setWorker(async (payload) => {
    // payload is typed as CrawlPayload
    console.log(payload.url.toUpperCase());  // ✅ Type-safe
  })
  .add({ url: 'https://example.com' });  // ✅ Type-checked

tq<CrawlPayload>('crawl')
  .add({ wrong: 'field' });  // ❌ Type error
```

### 2.3 Management API (REST/Admin Only)

**Purpose:** Administrative operations (monitoring, debugging)

**Note:** These are NOT exposed to application code - only via REST API or admin UI

```javascript
// Not part of tq() interface - only available via REST endpoints

GET  /api/tasks/:id           // Get task details
GET  /api/tasks               // List/filter tasks
POST /api/tasks/:id/retry     // Manual retry
DELETE /api/tasks/:id         // Delete task
DELETE /api/tasks             // Bulk cleanup
GET  /api/tasks/stats         // Queue statistics
POST /api/tasks/pause         // Pause all workers
POST /api/tasks/resume        // Resume all workers
POST /api/tasks/rate-limit    // Set global rate limit
```

**Rationale:**
- ✅ **Separation**: Application code doesn't need these
- ✅ **Security**: Can protect admin endpoints with auth
- ✅ **Simplicity**: Application API stays clean and focused

---

## 3. Data Models

### 3.1 Database Schema

**Table: `tasks`**

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT/VARCHAR(36) | PRIMARY KEY | UUID v4 |
| `type` | TEXT/VARCHAR(255) | NOT NULL | Task type identifier |
| `payload` | TEXT/JSON | NOT NULL | Task input data (JSON) |
| `status` | TEXT/VARCHAR(20) | NOT NULL, DEFAULT 'pending' | `pending`, `processing`, `completed`, `failed` |
| `version` | INTEGER | NOT NULL, DEFAULT 0 | Optimistic lock version (incremented on claim) |
| `attempts` | INTEGER | DEFAULT 0 | Execution attempt count |
| `max_attempts` | INTEGER | DEFAULT 3 | Give up after this many attempts |
| `last_attempt_at` | TIMESTAMP/TEXT | NULL | ISO timestamp of last execution |
| `next_retry_at` | TIMESTAMP/TEXT | NULL | ISO timestamp for next retry (NULL = ready now) |
| `result` | TEXT/JSON | NULL | Success result (JSON) |
| `error` | TEXT | NULL | Error message (failure only) |
| `run_after` | TIMESTAMP/TEXT | NULL | Don't run before this timestamp |
| `created_at` | TIMESTAMP/TEXT | NOT NULL | ISO timestamp |
| `updated_at` | TIMESTAMP/TEXT | NOT NULL | ISO timestamp |
| `completed_at` | TIMESTAMP/TEXT | NULL | ISO timestamp (when reached terminal state) |

**Indexes:**

```sql
-- Critical for worker queries (FIFO + retry timing)
CREATE INDEX idx_tasks_pending
ON tasks(status, created_at ASC, next_retry_at)
WHERE status IN ('pending', 'failed');

-- Fast type-based queries
CREATE INDEX idx_tasks_type ON tasks(type, status);

-- Chronological listing
CREATE INDEX idx_tasks_created ON tasks(created_at DESC);
```

**Status Transitions:**

```
pending → processing → completed ✓
pending → processing → failed → [retry] → pending → processing → completed ✓
pending → processing → failed → [max attempts] → failed (terminal)
```

### 3.2 JSON Data Structures

**EnqueueOptions:**
```json
{
  "maxAttempts": 3,                      // int (optional, default: 3)
  "runAfter": "2025-01-15T10:00:00Z"     // ISO timestamp (optional)
}
```

**Task:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "send_email",
  "payload": {
    "to": "user@example.com",
    "subject": "Welcome"
  },
  "status": "completed",
  "attempts": 2,
  "maxAttempts": 3,
  "lastAttemptAt": "2025-01-15T10:05:30Z",
  "nextRetryAt": null,
  "result": {
    "messageId": "abc123"
  },
  "error": null,
  "runAfter": null,
  "createdAt": "2025-01-15T10:00:00Z",
  "updatedAt": "2025-01-15T10:05:30Z",
  "completedAt": "2025-01-15T10:05:30Z"
}
```

**ListFilters:**
```json
{
  "type": "send_email",       // string (optional)
  "status": "failed",         // string or array (optional)
  "limit": 50,                // int (optional, default: 50)
  "offset": 0                 // int (optional, default: 0)
}
```

**QueueStats:**
```json
{
  "pending": 42,
  "processing": 3,
  "completed": 1205,
  "failed": 15,
  "byType": {
    "send_email": {
      "pending": 10,
      "completed": 500,
      "failed": 3
    },
    "process_image": {
      "pending": 32,
      "completed": 705,
      "failed": 12
    }
  }
}
```

---

## 4. Core Modules

### 4.1 Task Manager Module

**Responsibility:** CRUD operations on tasks table

**Functions:**
- `createTask(type, payload, options)` → taskId
- `getTaskById(id)` → Task | null
- `listTasks(filters)` → Task[]
- `updateTaskStatus(id, status, updates)` → void
- `deleteTask(id)` → Boolean
- `incrementAttempts(id)` → void
- `setTaskResult(id, result)` → void
- `setTaskError(id, error)` → void

**Implementation Notes:**
- Use transactions for atomic updates
- Convert timestamps to/from ISO 8601 strings
- Parse/stringify JSON for payload/result fields
- Validate status transitions

### 4.2 Scheduler Module

**Responsibility:** Calculate retry delays, schedule tasks, enforce rate limits

**Functions:**
- `calculateNextRetry(attempts)` → Timestamp
- `shouldRunNow(task)` → Boolean
- `getReadyTasks(batchSize)` → Task[]
- `canExecuteNow()` → Boolean (checks rate limit)
- `trackExecution()` → void (updates rate limit counter)

**Task Selection (FIFO Order):**

```sql
SELECT * FROM tasks
WHERE status IN ('pending', 'failed')
  AND (run_after IS NULL OR run_after <= NOW())
  AND (next_retry_at IS NULL OR next_retry_at <= NOW())
ORDER BY created_at ASC  -- FIFO: oldest first
LIMIT batchSize;
```

**Retry Strategy (Exponential Backoff with Jitter):**

```
Base delay: 10 seconds
Formula: delay = min(10 * 2^attempts + jitter(), 21600)
Jitter: random(-20%, +20%)
Max delay: 6 hours (21600 seconds)

Examples:
Attempt 1: ~10s (range: 8-12s)
Attempt 2: ~40s (range: 32-48s)
Attempt 3: ~2.6min (range: 2.1-3.1min)
Attempt 4: ~10.6min (range: 8.5-12.7min)
Attempt 5: ~42.6min (range: 34.1-51.1min)
Attempt 6+: ~6hr (capped)
```

**Rate Limiting (Token Bucket Algorithm):**

```
Configuration: maxRPS (tasks per second)

Implementation:
- Track: lastExecutionTime, tokensAvailable
- Refill: tokens += (now - lastExecutionTime) * maxRPS
- Cap: tokens = min(tokens, maxRPS)
- Execute: if tokens >= 1, decrement and proceed
- Wait: if tokens < 1, skip this poll cycle

Example: maxRPS = 10
- Can execute 10 tasks/sec
- Burst up to 10 tasks instantly
- Then throttle to 1 task per 100ms
```

**Implementation Notes:**
- Add jitter to prevent thundering herd
- Respect `run_after` constraint
- FIFO order (created_at ASC)
- Rate limit applied per worker instance

### 4.3 Executor Module

**Responsibility:** Execute tasks using registered handlers with exactly-once guarantee

**Functions:**
- `registerHandler(type, handler)` → void
- `unregisterHandler(type)` → void
- `executeTask(task)` → Result | Error
- `recoverStaleTasks(timeout)` → Integer (recovered count)

**Exactly-Once Execution (Optimistic Locking):**

```sql
-- Claim task atomically (only one worker succeeds)
UPDATE tasks
SET status = 'processing',
    version = version + 1,           -- Increment version
    last_attempt_at = NOW(),
    attempts = attempts + 1,
    updated_at = NOW()
WHERE id = ?
  AND status IN ('pending', 'failed')
  AND version = ?;                   -- Check current version

-- If rowsAffected = 0, another worker claimed it (skip)
-- If rowsAffected = 1, we claimed it (proceed)
```

**Why This Works:**
- Version checked in WHERE clause
- If another worker updated first, version changed
- Our UPDATE fails (rowsAffected = 0)
- No duplicate execution
- Cost: 1 extra integer column, negligible overhead

**Stale Task Recovery (Timeout Protection):**

```sql
-- Find tasks stuck in 'processing' for > timeout
SELECT * FROM tasks
WHERE status = 'processing'
  AND last_attempt_at < NOW() - INTERVAL timeout
LIMIT 100;

-- Reset to pending for retry
UPDATE tasks
SET status = 'pending',
    next_retry_at = NULL,
    updated_at = NOW()
WHERE id = ?
  AND status = 'processing'
  AND last_attempt_at < NOW() - INTERVAL timeout;
```

**Recovery Mechanism:**
- Worker polls for stale tasks every poll cycle
- Default timeout: 5 minutes (configurable)
- Handles: crashes, network issues, OOM kills, hung processes
- Does NOT handle: slow handlers (that's handler's responsibility)

**Execution Flow:**

```
1. Claim task atomically (optimistic lock)
   - If failed (version mismatch): skip
   - If success: proceed

2. Check if handler registered for task.type
   - If no: log warning, skip task
   - If yes: proceed

3. Call handler(task.payload)
   - If success:
     - UPDATE status = 'completed', result, completed_at
     - WHERE id = ? AND version = currentVersion
   - If error:
     - Calculate next_retry_at
     - UPDATE status = 'failed', error, next_retry_at
     - WHERE id = ? AND version = currentVersion
     - If attempts >= max_attempts: set completed_at (terminal)

4. If UPDATE rowsAffected = 0:
   - Another worker may have recovered this task (timeout)
   - Log warning, skip (avoid duplicate work)
```

**Implementation Notes:**
- Always check version in WHERE clause
- Catch all handler exceptions/errors
- Use database transactions for atomic updates
- Log execution events (claimed, completed, failed, skipped)
- Run stale task recovery periodically (every poll cycle)

### 4.4 Worker Module

**Responsibility:** Background polling and batch processing with pause/resume

**Functions:**
- `start(pollInterval, batchSize)` → void
- `stop()` → void (graceful shutdown)
- `pause()` → void (stop executing, keep polling)
- `resume()` → void (resume execution)
- `isRunning()` → Boolean
- `isPaused()` → Boolean
- `processBatch()` → Integer (processedCount)

**Worker Loop:**

```
while (running) {
  // 1. Recover stale tasks (every poll cycle)
  recoveredCount = executor.recoverStaleTasks(timeout)
  if (recoveredCount > 0) {
    log("Recovered ${recoveredCount} stale tasks")
  }

  // 2. Check if paused
  if (paused) {
    // Paused: poll but don't execute
    sleep(pollInterval)
    continue
  }

  // 3. Fetch batch of ready tasks from Scheduler
  tasks = scheduler.getReadyTasks(batchSize)

  // 4. Process each task
  for (task in tasks) {
    // Check rate limit
    if (!scheduler.canExecuteNow()) {
      break  // Skip remaining tasks, wait for next poll
    }

    // Execute via Executor (with optimistic locking)
    executor.executeTask(task)
    scheduler.trackExecution()
  }

  // 5. Sleep for pollInterval
  sleep(pollInterval)
}
```

**Pause Behavior:**

```
When paused:
- Worker continues polling (keeps state alive)
- No tasks executed
- Status queries still work
- Can resume instantly without restart

Use cases:
- Maintenance window
- Debugging
- Temporary overload
- Manual intervention
```

**Parallelism (Future Feature):**

```
Current: Sequential (parallelism = 1)
- Process one task at a time
- Simple, predictable

Future: Concurrent (parallelism > 1)
- Process N tasks in parallel
- Use threads/goroutines/async
- Need task locking to prevent duplicate execution
```

**Implementation Notes:**
- Use polling (not push-based)
- Configurable poll interval (default: 1000ms)
- Configurable batch size (default: 10)
- Graceful shutdown: finish current batch before stopping
- Pause is instant (checks flag before each task)
- Default: Sequential processing (parallelism = 1)

---

## 5. API Specification

### 5.1 REST API Endpoints

**Base Path:** `/api/tasks`

#### POST /api/tasks

**Description:** Create new task

**Request:**
```json
{
  "type": "send_email",
  "payload": {
    "to": "user@example.com",
    "subject": "Welcome"
  },
  "options": {
    "maxAttempts": 3,
    "runAfter": "2025-01-15T10:00:00Z"
  }
}
```

**Response:** `201 Created`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "send_email",
  "status": "pending",
  "createdAt": "2025-01-15T09:55:00Z"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid type or payload

#### GET /api/tasks/:id

**Description:** Get task by ID

**Response:** `200 OK`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "send_email",
  "payload": { "to": "user@example.com" },
  "status": "completed",
  "attempts": 1,
  "result": { "messageId": "abc123" },
  "error": null,
  "createdAt": "2025-01-15T09:55:00Z",
  "completedAt": "2025-01-15T10:00:00Z"
}
```

**Error Responses:**
- `404 Not Found`: Task does not exist

#### GET /api/tasks

**Description:** List tasks with filters

**Query Parameters:**
- `type` (optional): Filter by task type
- `status` (optional): Filter by status (can repeat: `status=failed&status=pending`)
- `limit` (optional): Max results (default: 50, max: 100)
- `offset` (optional): Pagination offset (default: 0)

**Response:** `200 OK`
```json
{
  "tasks": [
    { "id": "...", "type": "...", "status": "..." },
    { "id": "...", "type": "...", "status": "..." }
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

#### POST /api/tasks/:id/retry

**Description:** Retry failed task immediately

**Response:** `200 OK`
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "attempts": 0,
  "nextRetryAt": null
}
```

**Error Responses:**
- `404 Not Found`: Task does not exist
- `400 Bad Request`: Task not in failed state

#### DELETE /api/tasks/:id

**Description:** Delete task (only if completed/failed)

**Response:** `204 No Content`

**Error Responses:**
- `404 Not Found`: Task does not exist
- `400 Bad Request`: Task still pending/processing

#### GET /api/tasks/stats

**Description:** Get queue statistics

**Response:** `200 OK`
```json
{
  "pending": 42,
  "processing": 3,
  "completed": 1205,
  "failed": 15,
  "byType": {
    "send_email": {
      "pending": 10,
      "completed": 500,
      "failed": 3
    }
  }
}
```

#### POST /api/tasks/pause

**Description:** Pause worker (stop executing tasks, keep polling)

**Response:** `200 OK`
```json
{
  "paused": true
}
```

#### POST /api/tasks/resume

**Description:** Resume worker (start executing tasks again)

**Response:** `200 OK`
```json
{
  "paused": false
}
```

#### POST /api/tasks/rate-limit

**Description:** Set rate limit (tasks per second)

**Request:**
```json
{
  "tasksPerSecond": 10  // 0 = unlimited
}
```

**Response:** `200 OK`
```json
{
  "tasksPerSecond": 10
}
```

#### DELETE /api/tasks

**Description:** Cleanup old tasks

**Query Parameters:**
- `olderThan` (required): ISO timestamp (delete completed tasks older than this)

**Response:** `200 OK`
```json
{
  "deleted": 350
}
```

**Error Responses:**
- `400 Bad Request`: Invalid timestamp

### 5.2 Programmatic API (Application Code)

**Simple, task-type scoped interface:**

```javascript
import { tq } from '@/lib/task-queue';

// Initialize once (app startup)
tq.init({ db, pollInterval: 1000, batchSize: 10 });

// Setup workers (per task type)
tq('send_email')
  .setWorker(async (payload) => {
    await sendEmail(payload.to, payload.subject, payload.body);
  })
  .setWorkerCount(2)
  .setRateLimit(10)
  .setTimeout(30);

tq('process_image')
  .setWorker(async (payload) => {
    await processImage(payload.imageUrl);
  })
  .setWorkerCount(4)
  .setRateLimit(20)
  .setTimeout(300);

// Enqueue tasks (anywhere in app)
tq('send_email').add({
  to: 'user@example.com',
  subject: 'Welcome',
  body: 'Hello!'
});

tq('process_image').add({ imageUrl: '/uploads/photo.jpg' });

// Advanced: Custom options
tq('send_email').add(
  { to: 'vip@example.com', subject: 'Important' },
  { maxAttempts: 10, runAfter: new Date('2025-12-31') }
);

// Global controls
tq.pause();                    // Pause all workers
tq.resume();                   // Resume all workers
const stats = tq.stats();      // Get queue statistics
await tq.stop();               // Graceful shutdown
```

**Management operations (use REST API instead):**
```javascript
// These are NOT part of tq() interface
// Use REST endpoints: GET /api/tasks, POST /api/tasks/:id/retry, etc.
```

---

## 6. UI Components

### 6.1 Task List View

**Purpose:** Display tasks with filtering and actions

**Features:**
- Table/list of tasks
- Columns: ID, Type, Status, Attempts, Created, Actions
- Status badge (color-coded)
- Filter by type (dropdown)
- Filter by status (checkboxes: pending, processing, completed, failed)
- Pagination (prev/next)
- Actions per row: Retry (failed only), Delete (completed/failed only)
- Worker controls: Pause/Resume, Rate limit setting

**Pseudocode:**
```jsx
<TaskList>
  <Controls>
    <Button onClick={pauseWorker} *ngIf="!paused">Pause Worker</Button>
    <Button onClick={resumeWorker} *ngIf="paused">Resume Worker</Button>
    <Input label="Rate Limit (tasks/sec)" value={rateLimit} onChange={setRateLimit} />
  </Controls>

  <Filters>
    <TypeDropdown options={taskTypes} />
    <StatusCheckboxes options={['pending', 'processing', 'completed', 'failed']} />
  </Filters>

  <Table>
    <Row *ngFor="task in tasks">
      <Cell>{task.id}</Cell>
      <Cell>{task.type}</Cell>
      <Cell><StatusBadge status={task.status} /></Cell>
      <Cell>{task.attempts}/{task.maxAttempts}</Cell>
      <Cell>{formatDate(task.createdAt)}</Cell>
      <Cell>
        <Button *ngIf="task.status === 'failed'" onClick={retry(task.id)}>Retry</Button>
        <Button *ngIf="['completed', 'failed'].includes(task.status)" onClick={delete(task.id)}>Delete</Button>
      </Cell>
    </Row>
  </Table>

  <Pagination current={page} total={totalPages} />
</TaskList>
```

### 6.2 Task Detail View

**Purpose:** Show full task information

**Features:**
- Task metadata (id, type, status, attempts, timestamps)
- Payload (JSON viewer)
- Result (JSON viewer, if completed)
- Error message (if failed)
- Retry timeline (list of attempts with timestamps and errors)
- Actions: Retry, Delete

**Pseudocode:**
```jsx
<TaskDetail task={task}>
  <Section title="Metadata">
    <Field label="ID">{task.id}</Field>
    <Field label="Type">{task.type}</Field>
    <Field label="Status"><StatusBadge status={task.status} /></Field>
    <Field label="Attempts">{task.attempts}/{task.maxAttempts}</Field>
    <Field label="Created">{formatDate(task.createdAt)}</Field>
    {task.completedAt && <Field label="Completed">{formatDate(task.completedAt)}</Field>}
    {task.runAfter && <Field label="Scheduled">{formatDate(task.runAfter)}</Field>}
  </Section>

  <Section title="Payload">
    <JsonViewer data={task.payload} />
  </Section>

  {task.result && (
    <Section title="Result">
      <JsonViewer data={task.result} />
    </Section>
  )}

  {task.error && (
    <Section title="Error">
      <ErrorMessage>{task.error}</ErrorMessage>
    </Section>
  )}

  <Section title="Actions">
    <Button *ngIf="task.status === 'failed'" onClick={retry}>Retry Now</Button>
    <Button *ngIf="['completed', 'failed'].includes(task.status)" onClick={delete}>Delete</Button>
  </Section>
</TaskDetail>
```

### 6.3 Queue Stats Dashboard

**Purpose:** Show queue health metrics

**Features:**
- Status breakdown (pie chart or cards)
- Tasks by type (bar chart)
- Recent failures (list of last 10 failed tasks)
- Processing rate (tasks/hour)
- Cleanup action (delete old completed tasks)

**Pseudocode:**
```jsx
<StatsDashboard stats={stats}>
  <Section title="Status Overview">
    <Card>
      <Metric label="Pending" value={stats.pending} color="blue" />
      <Metric label="Processing" value={stats.processing} color="yellow" />
      <Metric label="Completed" value={stats.completed} color="green" />
      <Metric label="Failed" value={stats.failed} color="red" />
    </Card>
  </Section>

  <Section title="By Type">
    <BarChart data={stats.byType} />
  </Section>

  <Section title="Actions">
    <Button onClick={cleanupOldTasks}>Clean Up Completed Tasks</Button>
  </Section>
</StatsDashboard>
```

### 6.4 Status Badge Component

**Purpose:** Color-coded status indicator

**Pseudocode:**
```jsx
<StatusBadge status={status}>
  {status === 'pending' && <Badge color="blue">Pending</Badge>}
  {status === 'processing' && <Badge color="yellow">Processing</Badge>}
  {status === 'completed' && <Badge color="green">Completed</Badge>}
  {status === 'failed' && <Badge color="red">Failed</Badge>}
</StatusBadge>
```

---

## 7. Reference Implementation

### 7.1 Technology Stack

**Language:** Node.js (TypeScript)
**Database:** SQLite (better-sqlite3)
**Framework:** Next.js 15 (App Router)
**UI Library:** shadcn/ui (React)

### 7.2 Module Structure

```
src/lib/task-queue/
├── index.ts                 # Main export
├── task-queue.ts            # TaskQueue class
├── task-manager.ts          # TaskManager class (CRUD)
├── scheduler.ts             # Scheduler class (retry logic)
├── executor.ts              # Executor class (run handlers)
├── worker.ts                # Worker class (background polling)
├── types.ts                 # TypeScript types
└── migrations/
    └── 001_create_tasks.sql # Database schema

src/app/api/tasks/
├── route.ts                 # POST /api/tasks, GET /api/tasks
├── [id]/
│   ├── route.ts            # GET /api/tasks/:id, DELETE /api/tasks/:id
│   ├── retry/
│   │   └── route.ts        # POST /api/tasks/:id/retry
│   └── cancel/
│       └── route.ts        # POST /api/tasks/:id/cancel
└── stats/
    └── route.ts             # GET /api/tasks/stats

src/app/tasks/
├── page.tsx                 # Task list page
├── [id]/
│   └── page.tsx            # Task detail page
└── stats/
    └── page.tsx            # Stats dashboard

src/components/tasks/
├── TaskList.tsx             # Table with filters
├── TaskDetail.tsx           # Detail view
├── TaskStats.tsx            # Stats dashboard
├── StatusBadge.tsx          # Status indicator
└── JsonViewer.tsx           # JSON display
```

### 7.3 Interface Design

#### Global tq() Function

```typescript
// Global singleton instance
interface TQ {
  // Initialize (call once at app startup)
  init(options: TaskQueueOptions): void;

  // Access task-type context
  <T = any>(type: string): TaskTypeContext<T>;

  // Global controls
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
  stats(): QueueStats;
}

// Options for initialization
interface TaskQueueOptions {
  db: Database;                // better-sqlite3 instance
  pollInterval?: number;        // milliseconds (default: 1000)
  batchSize?: number;          // tasks per batch (default: 10)
  taskTimeout?: number;        // task timeout in seconds (default: 300)
}

// Task-type scoped context (chainable)
interface TaskTypeContext<T = any> {
  // Enqueue task
  add(payload: T, options?: EnqueueOptions): TaskTypeContext<T>;

  // Configure worker
  setWorker(handler: TaskHandler<T>): TaskTypeContext<T>;
  setWorkerCount(count: number): TaskTypeContext<T>;
  setRateLimit(tasksPerSecond: number): TaskTypeContext<T>;
  setTimeout(seconds: number): TaskTypeContext<T>;
}

// Task handler
type TaskHandler<T = any> = (payload: T) => Promise<any>;

// Enqueue options
interface EnqueueOptions {
  maxAttempts?: number;
  runAfter?: Date;
}
```

**Usage Example:**

```typescript
import { tq } from '@/lib/task-queue';

// Initialize
tq.init({ db, pollInterval: 1000 });

// Setup (chainable)
tq<CrawlPayload>('crawl')
  .setWorker(async (payload) => await crawl(payload.url))
  .setWorkerCount(3)
  .setRateLimit(10)
  .setTimeout(300);

// Use (chainable)
tq('crawl')
  .add({ url: 'https://example.com/1' })
  .add({ url: 'https://example.com/2' });

// Control
tq.pause();
tq.resume();
```

#### TaskManager

```typescript
class TaskManager {
  constructor(db: Database);

  createTask(type: string, payload: any, options: EnqueueOptions): string;
  getTaskById(id: string): Task | null;
  listTasks(filters: ListFilters): Task[];
  updateTaskStatus(id: string, status: TaskStatus, updates: Partial<Task>): void;
  deleteTask(id: string): boolean;
  incrementAttempts(id: string): void;
  setTaskResult(id: string, result: any): void;
  setTaskError(id: string, error: string): void;
}
```

#### Scheduler

```typescript
class Scheduler {
  constructor(db: Database);

  calculateNextRetry(attempts: number): Date;
  shouldRunNow(task: Task): boolean;
  getReadyTasks(batchSize: number): Task[];

  // Rate limiting
  canExecuteNow(): boolean;
  trackExecution(): void;
  setRateLimit(tasksPerSecond: number): void;
  getRateLimit(): number;
}
```

#### Executor

```typescript
type TaskHandler<T = any> = (payload: T) => Promise<any>;

class Executor {
  constructor(taskManager: TaskManager, scheduler: Scheduler);

  registerHandler<T = any>(type: string, handler: TaskHandler<T>): void;
  unregisterHandler(type: string): void;
  executeTask(task: Task): Promise<void>;
}
```

#### Worker

```typescript
class Worker {
  constructor(executor: Executor, scheduler: Scheduler, options: WorkerOptions);

  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  processBatch(): Promise<number>;
}
```

---

## 8. Integration Guide

### 8.1 Database Setup

**Step 1:** Create tasks table
```sql
-- See section 3.1 for complete schema
CREATE TABLE tasks (...);
CREATE INDEX idx_tasks_pending ON tasks(...);
CREATE INDEX idx_tasks_type ON tasks(...);
```

**Step 2:** Run migrations (if using migration system)

### 8.2 Initialize Queue

```typescript
import Database from 'better-sqlite3';
import { TaskQueue } from '@/lib/task-queue';

// Initialize
const db = new Database('./database.sqlite');
const queue = new TaskQueue({
  db,
  pollInterval: 2000,   // 2 seconds
  batchSize: 5,         // 5 tasks per batch
  enableWorker: true,   // auto-start worker
  taskTimeout: 300      // 5 minutes (recover stale tasks)
});
```

### 8.3 Register Handlers

```typescript
// Define handlers
queue.registerHandler('send_email', async (payload) => {
  const { to, subject, body } = payload;
  const messageId = await sendEmail(to, subject, body);
  return { messageId };
});

queue.registerHandler('process_image', async (payload) => {
  const { imageUrl } = payload;
  const result = await processImage(imageUrl);
  return result;
});

queue.registerHandler('search_index', async (payload) => {
  const { itemId } = payload;
  await indexInMeilisearch(itemId);
  await indexInQdrant(itemId);
});
```

### 8.4 Enqueue Tasks

```typescript
// From application code
queue.enqueue('send_email', {
  to: 'user@example.com',
  subject: 'Welcome',
  body: 'Hello!'
}, {
  priority: 3,
  maxAttempts: 5
});

// From API route
export async function POST(request: NextRequest) {
  const { type, payload, options } = await request.json();
  const taskId = queue.enqueue(type, payload, options);
  return NextResponse.json({ id: taskId }, { status: 201 });
}
```

### 8.5 Mount UI Routes

```typescript
// src/app/tasks/page.tsx
import { TaskList } from '@/components/tasks/TaskList';

export default function TasksPage() {
  return <TaskList />;
}
```

---

## 9. Concerns & Considerations

### 9.1 Known Limitations

1. **Single Database Required**: All workers must share same database
2. **SQLite Concurrency**: Limited to ~1000 writes/sec (use WAL mode)
3. **No Multi-Server Coordination**: Not designed for distributed setups
4. **Sequential Processing**: Tasks in batch processed one-by-one
5. **No Task Dependencies**: Can't express "run B after A"

### 9.2 Security Considerations

- **Payload Validation**: Handlers must validate payload data
- **SQL Injection**: Use parameterized queries (NOT string concatenation)
- **API Authentication**: Protect REST endpoints with auth middleware
- **Rate Limiting**: Prevent abuse of enqueue endpoint
- **Result Size**: Limit result JSON size to prevent DoS

### 9.3 Performance Optimization

- **Partial Indexes**: Use `WHERE status IN ('pending', 'failed')` for worker queries
- **Connection Pooling**: Reuse database connections
- **Batch Size Tuning**: Adjust based on handler execution time
- **Poll Interval Tuning**: Reduce for low-latency, increase for efficiency
- **Cleanup Schedule**: Run cleanup during off-peak hours

### 9.4 Monitoring & Observability

**Metrics to Track:**
- Queue depth (pending count)
- Processing rate (tasks/minute)
- Failure rate (failed/total)
- Retry rate (attempts > 1 count)
- Handler latency (execution time)
- Worker health (last poll time)

**Logging:**
- Log task enqueue (type, id)
- Log task execution start/end
- Log task failures (error message)
- Log worker start/stop
- Log handler registration

### 9.5 Prior Art & Similar Projects

**Existing Systems:**
- **BullMQ** (Node.js, Redis): Feature-rich, requires Redis
- **Celery** (Python, various brokers): Distributed, complex setup
- **Sidekiq** (Ruby, Redis): Production-proven, Redis-dependent
- **pg-boss** (Node.js, PostgreSQL): Similar concept, Postgres-specific
- **Faktory** (Language-agnostic, Redis protocol): Closest to this spec

**Prompt-Only Library Concept:**
- **Novel approach**: No existing "prompt-only OSS lib" found
- **Benefits**: Technology-agnostic, easy to customize, no dependency hell
- **Risks**: Implementation quality varies by agent/developer
- **Recommendation**: Provide reference implementation + test suite

---

## 10. Testing Guide

### 10.1 Unit Tests

**Test Coverage:**
- Task creation (valid/invalid payloads)
- Task status transitions
- Retry delay calculation
- Handler execution (success/failure)
- Idempotency (duplicate prevention)
- Task cancellation (allowed/forbidden states)
- Cleanup (old task deletion)

**Example Test:**
```typescript
test('should retry failed task with exponential backoff', async () => {
  const queue = new TaskQueue({ db, enableWorker: false });
  let attempts = 0;

  queue.registerHandler('test', async () => {
    attempts++;
    if (attempts < 3) throw new Error('Fail');
  });

  const taskId = queue.enqueue('test', {}, { maxAttempts: 3 });

  await queue.processBatch();  // Attempt 1: fail
  expect(queue.getTask(taskId).status).toBe('failed');

  await queue.processBatch();  // Attempt 2: fail
  expect(queue.getTask(taskId).attempts).toBe(2);

  await queue.processBatch();  // Attempt 3: success
  expect(queue.getTask(taskId).status).toBe('completed');
  expect(attempts).toBe(3);
});
```

### 10.2 Integration Tests

**Test Scenarios:**
- End-to-end task processing
- Concurrent worker safety
- API endpoint responses
- UI component rendering
- Database constraint enforcement

### 10.3 Load Tests

**Benchmarks:**
- Enqueue 1000 tasks/sec
- Process 100 tasks/sec (depends on handler)
- List 10,000 tasks with pagination
- Cleanup 100,000 old tasks

---

## 11. FAQ

**Q: Why not use existing library like BullMQ?**
A: Existing libraries are language/database-specific. This spec works for any stack.

**Q: Can I use this with PostgreSQL/MySQL?**
A: Yes! Adjust SQL syntax (timestamps, JSON types) but logic is identical.

**Q: How do I handle long-running tasks?**
A: Keep handlers under 30 seconds. For longer tasks, split into smaller tasks or use separate worker process.

**Q: Can multiple servers run workers?**
A: Yes, with shared database. Use `UPDATE ... WHERE status = 'pending'` for atomic task claiming.

**Q: How do I prioritize within same priority level?**
A: Use `created_at` as tiebreaker (older first). Or add `scheduled_for` field.

**Q: What about task progress tracking?**
A: Out of scope. Handlers can update external state, but queue doesn't track progress percentage.

**Q: Can I modify task payload after enqueueing?**
A: No. Enqueue new task or cancel+re-enqueue.

**Q: How do I debug failed tasks?**
A: Check `error` field in task record. Add detailed logging in handlers.

---

## 12. Changelog

**v1.0 (2025-01-28)**
- Initial specification
- Language-agnostic, database-agnostic design
- Complete API, UI, and reference implementation specs

---

## License

This specification is released into the public domain (CC0 1.0 Universal).
Implementations may use any license.

---

**End of Specification**

> **Implementation Checklist:**
> ☐ Database schema created
> ☐ Core modules implemented (Manager, Scheduler, Executor, Worker)
> ☐ API endpoints created
> ☐ UI components built
> ☐ Handlers registered
> ☐ Tests written
> ☐ Documentation updated
> ☐ Worker deployed
