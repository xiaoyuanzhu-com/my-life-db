# Notifications Service

The notifications service provides real-time updates to the frontend via Server-Sent Events (SSE).

## Architecture

```
Backend Components                Notifications Service              Browser
      |                                    |                            |
      |-- NotifyInboxChanged() ----------->|                            |
      |                                    |-- broadcast --------------->|
      |-- NotifyDigestComplete() --------->|    (SSE)                   |
      |                                    |-- broadcast --------------->|
```

## Key Components

| Location | Purpose |
|----------|---------|
| `backend/notifications/service.go` | Pub/sub service |
| `backend/api/notifications.go` | SSE HTTP handler |

## Service Structure

```go
type Service struct {
    subscribers map[chan Event]struct{}  // Active SSE connections
    mu          sync.RWMutex             // Protects subscribers map
    done        chan struct{}            // Shutdown signal
}

type Event struct {
    Type string      `json:"type"`
    Data interface{} `json:"data,omitempty"`
}
```

## Event Types

| Type | Triggered By | Purpose |
|------|--------------|---------|
| `inbox-changed` | File added/modified in inbox | Refresh inbox UI |
| `digest-update` | Digest processing complete | Update file metadata display |
| `preview-updated` | Thumbnail/preview generated | Show preview in UI |
| `pin-changed` | File pinned/unpinned | Update pin indicators |
| `connected` | Client connects | Initial handshake |

## Usage Pattern

### Publishing Events

```go
// From anywhere with access to notifications service
s.notifService.Notify(notifications.Event{
    Type: "inbox-changed",
    Data: map[string]string{"path": filePath},
})
```

### Subscribing (Internal)

```go
eventChan, unsubscribe := svc.Subscribe()
defer unsubscribe()

for event := range eventChan {
    // Handle event
}
```

## SSE Handler

```go
// backend/api/notifications.go
func (h *Handlers) NotificationStream(c *gin.Context) {
    // Set SSE headers
    c.Header("Content-Type", "text/event-stream")
    c.Header("Cache-Control", "no-cache")
    c.Header("Connection", "keep-alive")

    eventChan, unsubscribe := h.server.Notifications().Subscribe()
    defer unsubscribe()

    // Send initial connected event
    sendEvent(c, Event{Type: "connected"})

    for {
        select {
        case event := <-eventChan:
            sendEvent(c, event)
        case <-c.Request.Context().Done():
            return
        case <-h.server.ShutdownContext().Done():
            return
        }
    }
}
```

## Frontend Usage

```typescript
// frontend/app/hooks/use-notifications.ts
const useNotifications = () => {
    useEffect(() => {
        const eventSource = new EventSource('/api/notifications/stream')

        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data)
            switch (data.type) {
                case 'inbox-changed':
                    queryClient.invalidateQueries(['inbox'])
                    break
                case 'digest-update':
                    queryClient.invalidateQueries(['file', data.data.path])
                    break
            }
        }

        return () => eventSource.close()
    }, [])
}
```

## Buffered Channels

Subscriber channels are buffered to prevent slow clients from blocking:

```go
func (s *Service) Subscribe() (chan Event, func()) {
    ch := make(chan Event, 100)  // Buffer 100 events
    // ...
}

func (s *Service) Notify(event Event) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    for ch := range s.subscribers {
        select {
        case ch <- event:
            // Sent
        default:
            // Channel full, drop event for this subscriber
            log.Warn().Msg("dropping event, subscriber too slow")
        }
    }
}
```

## Common Modifications

### Adding a new event type

1. Define event type constant (optional, can use string directly)
2. Add `Notify*` convenience method to service (optional)
3. Broadcast from relevant backend code
4. Handle in frontend `useNotifications` hook

```go
// backend/notifications/service.go
func (s *Service) NotifyFileRenamed(oldPath, newPath string) {
    s.Notify(Event{
        Type: "file-renamed",
        Data: map[string]string{
            "oldPath": oldPath,
            "newPath": newPath,
        },
    })
}
```

### Adding event filtering

Clients could subscribe to specific event types:

```go
func (s *Service) SubscribeFiltered(types []string) (chan Event, func()) {
    // Filter events before sending to channel
}
```

### Adding event history/replay

For clients that reconnect and need missed events:

```go
type Service struct {
    recentEvents []Event  // Ring buffer of recent events
    // ...
}
```

## Files to Modify

| Task | Files |
|------|-------|
| Add event types | `backend/notifications/service.go` |
| Change SSE behavior | `backend/api/notifications.go` |
| Frontend handling | `frontend/app/hooks/use-notifications.ts` |
