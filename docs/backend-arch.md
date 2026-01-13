# Backend Architecture

## Overview

MyLifeDB backend is a Go HTTP server that manages a filesystem-based personal knowledge management system. The architecture follows a modular design with clear separation of concerns, explicit dependency management, and support for hot-reloadable configuration.

## Core Principles

1. **No Dependency Injection**: Simple, straightforward initialization
2. **Explicit Dependencies**: Each module declares what it needs via typed config structs
3. **Clear Ownership**: Server owns all stateful components
4. **No Global Singletons**: Except for cross-cutting concerns (logging)
5. **Hot-Reloadable Config**: Application settings can be updated at runtime

## High-Level Architecture

```mermaid
graph TD
    Main[main.go] -->|1. Initialize| Log[Logging System]
    Main -->|2. Load| ServerCfg[Server Config]
    Main -->|3. Create| Server[Server Instance]
    Main -->|4. Start/Stop| Server

    Server -->|owns| DB[Database]
    Server -->|owns| FS[FS Service]
    Server -->|owns| Digest[Digest Worker]
    Server -->|owns| Notif[Notifications]
    Server -->|owns| HTTP[HTTP Server]
    Server -->|owns| Router[Gin Router]

    FS -.->|file changes| Digest
    Digest -.->|status updates| Notif
    FS -.->|new files| Notif

    Router -->|routes to| Handlers[API Handlers]
    Handlers -->|use| Server
```

## Configuration Architecture

### Two-Level Configuration System

```mermaid
graph LR
    subgraph "Server Config (Infrastructure)"
        SC[Server Config]
        SC -->|immutable| Port
        SC -->|immutable| Host
        SC -->|immutable| DataDir
        SC -->|immutable| DatabasePath
    end

    subgraph "App Config (Application Behavior)"
        AC[App Config]
        AC -->|mutable| LogLevel
        AC -->|mutable| APIKeys
        AC -->|mutable| Workers
        AC -->|mutable| Features
    end

    Env[Environment Variables] -->|loads| SC
    File[config.json] -->|loads| SC

    SC -->|embedded in| AC
    DB[(Database)] -->|overrides| AC
    SettingsAPI[Settings API] -->|updates| DB
```

### Configuration Flow

```mermaid
sequenceDiagram
    participant Main
    participant ServerCfg as Server Config
    participant Server
    participant DB
    participant Module as FS/Digest/etc

    Main->>ServerCfg: Load from env/file
    Main->>Server: New(serverCfg)
    Server->>DB: Open database
    Server->>DB: Load app settings
    Note over Server: Merge settings into config
    Server->>Module: Create with module config
    Note over Module: Uses config values

    rect rgb(200, 220, 255)
        Note over Server,Module: Hot Reload Flow
        Server->>DB: Load updated settings
        Server->>Server: Merge into config
        Server->>Module: Restart if needed
    end
```

### Server Config (Immutable Infrastructure)

**Source**: Environment variables, config.json
**Loaded**: Once at startup
**Requires restart**: To change

```go
type server.Config struct {
    // Server infrastructure
    Port int
    Host string
    Env  string

    // Paths
    DataDir      string
    DatabasePath string

    // App settings (can be overridden by DB)
    FSScanInterval  time.Duration
    FSWatchEnabled  bool
    DigestWorkers   int
    DigestQueueSize int
    OpenAIKey       string
    HAIDBaseURL     string
    HAIDAPIKey      string
    MeiliHost       string
    QdrantURL       string
    QdrantAPIKey    string
}
```

### Module Configs (Explicit Dependencies)

Each module defines its own config struct:

```go
// db.Config
type db.Config struct {
    Path            string
    MaxOpenConns    int
    MaxIdleConns    int
    ConnMaxLifetime time.Duration
}

// fs.Config
type fs.Config struct {
    DataRoot     string
    ScanInterval time.Duration
    WatchEnabled bool
}

// digest.Config
type digest.Config struct {
    Workers      int
    QueueSize    int
    OpenAIKey    string
    HAIDBaseURL  string
    HAIDAPIKey   string
}
```

Server converts its config to module configs:

```go
func (c *server.Config) ToDBConfig() db.Config
func (c *server.Config) ToFSConfig() fs.Config
func (c *server.Config) ToDigestConfig() digest.Config
```

## Component Lifecycle

```mermaid
sequenceDiagram
    participant Main
    participant Server
    participant DB
    participant FS
    participant Digest
    participant HTTP

    Main->>Server: New(config)
    Server->>DB: Open(dbConfig)
    Server->>DB: Load app settings
    Note over Server: Merge settings into config
    Server->>FS: NewService(fsConfig)
    Server->>Digest: NewWorker(digestConfig)
    Server->>HTTP: Setup router

    Main->>Server: Start()
    Server->>FS: Start()
    Server->>Digest: Start()
    Server->>HTTP: ListenAndServe()

    Note over Server: Running...

    Main->>Server: Shutdown(ctx)
    Server->>HTTP: Shutdown(ctx)
    Server->>Digest: Stop()
    Server->>FS: Stop()
    Server->>DB: Close()
```

## Server Structure

```mermaid
classDiagram
    class Server {
        -config Config
        -db DB
        -fs Service
        -digest Worker
        -notif NotificationService
        -router Engine
        -http Server

        +New(config) Server
        +Start() error
        +Shutdown(ctx) error
        +ReloadConfig() error
        -loadAndMergeAppSettings() error
        -applyConfigChanges(old, new)
        -setupRouter()
        -connectServices()
    }

    class Config {
        +Port int
        +Host string
        +DataDir string
        +ToDBConfig() db.Config
        +ToFSConfig() fs.Config
        +ToDigestConfig() digest.Config
    }

    class FSService {
        -dataRoot string
        -validator validator
        -processor processor
        -watcher watcher
        -scanner scanner
        +NewService(config) Service
        +Start() error
        +Stop() error
        +WriteFile(req) result
        +ReadFile(path) reader
        +DeleteFile(path) error
    }

    class DigestWorker {
        -workers int
        -queue chan
        -registry Registry
        +NewWorker(config) Worker
        +Start()
        +Stop()
        +OnFileChange(path, isNew, contentChanged)
    }

    Server --> Config
    Server --> FSService
    Server --> DigestWorker
```

## Module Communication

### FS Service → Digest Worker

```mermaid
sequenceDiagram
    participant Watcher as FS Watcher
    participant FS as FS Service
    participant Digest as Digest Worker
    participant Notif as Notifications

    Watcher->>FS: File change detected
    FS->>FS: Process metadata
    FS->>FS: Update database
    FS->>Digest: OnFileChange(path, isNew, changed)
    Note over Digest: Queue for processing
    FS->>Notif: NotifyInboxChanged()

    Digest->>Digest: Process file
    Digest->>Digest: Run digesters
    Digest->>Digest: Save results
    Digest->>Notif: NotifyDigestComplete()
```

### API Handler → Server Components

```mermaid
sequenceDiagram
    participant Client
    participant Handler as API Handler
    participant Server
    participant FS as FS Service
    participant DB

    Client->>Handler: POST /api/inbox
    Handler->>Server: Get FS service
    Handler->>FS: WriteFile(request)
    FS->>FS: Validate path
    FS->>FS: Compute hash
    FS->>FS: Write to disk
    FS->>DB: Update metadata
    FS-->>Handler: WriteResult
    Handler-->>Client: JSON response
```

## Data Flow

### File Processing Pipeline

```mermaid
flowchart TD
    Start[File Added/Changed] --> Watch[FS Watcher Detects]
    Watch --> Validate[Validate Path]
    Validate --> Hash[Compute Hash]
    Hash --> Check{Hash Changed?}
    Check -->|No| Skip[Skip Processing]
    Check -->|Yes| Write[Write to Disk]
    Write --> Meta[Update Metadata in DB]
    Meta --> Notify1[Notify UI via SSE]
    Meta --> Queue[Queue for Digest]

    Queue --> Digest[Digest Worker]
    Digest --> Registry[Get Digesters]
    Registry --> Process[Process File]
    Process --> Extract[Extract Content/Metadata]
    Extract --> Save[Save to DB]
    Save --> Notify2[Notify UI via SSE]

    style Watch fill:#e1f5ff
    style Digest fill:#fff4e1
    style Notify1 fill:#e8f5e9
    style Notify2 fill:#e8f5e9
```

## Hot Config Reload

```mermaid
sequenceDiagram
    participant User
    participant API as Settings API
    participant Server
    participant DB
    participant Module as FS/Digest/etc

    User->>API: POST /api/settings
    API->>DB: Save new settings
    API->>Server: ReloadConfig()
    Server->>DB: Load app settings
    Server->>Server: Merge into config
    Server->>Server: Detect changes

    alt Log Level Changed
        Server->>Server: log.SetLevel(newLevel)
    end

    alt Digest Workers Changed
        Server->>Module: Stop()
        Server->>Module: Create with new config
        Server->>Module: Start()
    end

    alt API Keys Changed
        Note over Module: Modules read config on demand<br/>No restart needed
    end

    Server-->>API: Success
    API-->>User: 200 OK
```

## Directory Structure

```
backend/
├── main.go                 # Entry point, main() owns lifecycle
├── server/                 # Server package
│   ├── server.go          # Server struct and lifecycle
│   ├── config.go          # Server config struct
│   └── routes.go          # Router setup
├── api/                   # API handlers
│   ├── inbox.go           # Inbox endpoints
│   ├── library.go         # Library endpoints
│   ├── settings.go        # Settings endpoints
│   └── ...
├── db/                    # Database layer
│   ├── db.go             # Connection management
│   ├── config.go         # DB config struct
│   ├── migrations.go     # Schema migrations
│   └── models.go         # DB models
├── fs/                    # Filesystem service
│   ├── service.go        # Main service
│   ├── config.go         # FS config struct
│   ├── watcher.go        # File watcher
│   ├── scanner.go        # Periodic scanner
│   └── operations.go     # File operations
├── workers/               # Background workers
│   └── digest/
│       ├── worker.go     # Main worker
│       ├── config.go     # Digest config struct
│       ├── registry.go   # Digester registry
│       └── digesters/    # Individual digesters
├── notifications/         # SSE notifications
│   └── service.go
├── log/                   # Logging (package-level)
│   └── log.go
├── config/                # Config utilities (if needed)
│   └── loader.go
└── utils/                 # Shared utilities
    └── ...
```

## Initialization Sequence

```mermaid
flowchart TD
    Start([main.go starts]) --> Log[Initialize Logging]
    Log --> LoadCfg[Load Server Config<br/>from env/file]
    LoadCfg --> NewServer[server.New config]

    NewServer --> OpenDB[Open Database]
    OpenDB --> LoadSettings[Load App Settings from DB]
    LoadSettings --> MergeSettings[Merge into Config]
    MergeSettings --> ApplyLog[Apply Log Level]

    ApplyLog --> CreateFS[Create FS Service]
    CreateFS --> CreateDigest[Create Digest Worker]
    CreateDigest --> CreateNotif[Create Notifications]
    CreateNotif --> SetupRouter[Setup HTTP Router]

    SetupRouter --> Connect[Connect Services]
    Connect --> Ready[Server Ready]

    Ready --> StartFS[Start FS Service]
    StartFS --> StartDigest[Start Digest Worker]
    StartDigest --> StartHTTP[Start HTTP Server]

    StartHTTP --> Running([Server Running])

    style Start fill:#e8f5e9
    style Running fill:#e8f5e9
    style LoadSettings fill:#fff4e1
    style MergeSettings fill:#fff4e1
```

## API Handler Pattern

Handlers access server components through the server instance:

```go
// API handlers receive server instance
func SetupRoutes(router *gin.Engine, srv *Server) {
    router.POST("/api/inbox", srv.handleInboxCreate)
    router.GET("/api/inbox/:id", srv.handleInboxGet)
    // ...
}

// Handler methods on server
func (s *Server) handleInboxCreate(c *gin.Context) {
    // Access server components directly
    result, err := s.fs.WriteFile(c.Request.Context(), fs.WriteRequest{
        // ...
    })

    if err != nil {
        c.JSON(500, gin.H{"error": err.Error()})
        return
    }

    c.JSON(200, result)
}
```

## Error Handling Strategy

1. **Infrastructure errors** (DB, FS): Fail fast at startup
2. **Runtime errors**: Log and return HTTP error responses
3. **Background worker errors**: Log and retry with backoff
4. **Graceful degradation**: Continue serving if non-critical services fail

## Testing Strategy

### Unit Tests
- Each module testable independently
- Pass mock configs to constructors
- No global state to clean up

```go
func TestFSService(t *testing.T) {
    cfg := fs.Config{
        DataRoot: t.TempDir(),
        ScanInterval: 1 * time.Hour,
        WatchEnabled: false,
    }

    svc := fs.NewService(cfg)
    // Test service methods
}
```

### Integration Tests
- Create test server with test config
- Use test database
- Verify end-to-end flows

```go
func TestServerIntegration(t *testing.T) {
    cfg := &server.Config{
        Port: 0,  // Random port
        DataDir: t.TempDir(),
        DatabasePath: filepath.Join(t.TempDir(), "test.db"),
    }

    srv, err := server.New(cfg)
    // Test full server lifecycle
}
```

## Performance Considerations

1. **Concurrency**: Digest worker uses multiple goroutines
2. **File locking**: FS service prevents concurrent writes to same file
3. **Database**: Connection pooling with reasonable limits
4. **Caching**: Minimal in-memory caching, filesystem is source of truth
5. **SSE**: Efficient broadcast to multiple clients

## Future Enhancements

1. **Metrics**: Add Prometheus metrics endpoint
2. **Tracing**: Add OpenTelemetry tracing
3. **Health checks**: Add `/health` endpoint
4. **Rate limiting**: Add per-endpoint rate limiting
5. **API versioning**: Support multiple API versions
6. **Config validation**: Add comprehensive config validation
7. **Config schemas**: JSON schema for config files
