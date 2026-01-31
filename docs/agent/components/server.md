# Server Component

The Server struct owns and coordinates all application components, managing their lifecycle and interconnections.

## Architecture

```
                         Server
                           │
    ┌──────────────────────┼──────────────────────┐
    │                      │                      │
    ▼                      ▼                      ▼
 database            fsService              digestWorker
 (*db.DB)            (*fs.Service)          (*digest.Worker)
    │                      │                      │
    │                      │    callback          │
    │                      └──────────────────────┘
    │                             │
    │                      notifService
    │                      (*notifications.Service)
    │                             │
    └─────────────────────────────┘
                    │
               HTTP Router
               (*gin.Engine)
```

## Key Components

| Location | Purpose |
|----------|---------|
| `backend/server/server.go` | Server struct, lifecycle management |
| `backend/server/config.go` | Server configuration struct |

## Server Structure

```go
type Server struct {
    cfg *Config

    // Components (owned by server)
    database     *db.DB
    fsService    *fs.Service
    digestWorker *digest.Worker
    notifService *notifications.Service

    // Shutdown context - cancelled when server is shutting down
    // Long-running handlers (WebSocket, SSE) should listen to this
    shutdownCtx    context.Context
    shutdownCancel context.CancelFunc

    // HTTP
    router *gin.Engine
    http   *http.Server
}
```

## Initialization

### Order of Operations

Components must be initialized in this exact order (dependencies flow downward):

```go
func New(cfg *Config) (*Server, error) {
    ctx, cancel := context.WithCancel(context.Background())
    s := &Server{
        cfg:            cfg,
        shutdownCtx:    ctx,
        shutdownCancel: cancel,
    }

    // 1. Database (foundation, no dependencies)
    database, err := db.Open(cfg.ToDBConfig())
    s.database = database

    // 2. Load user settings and apply log level
    settings, err := db.LoadUserSettings()
    if err == nil && settings.Preferences.LogLevel != "" {
        log.SetLevel(settings.Preferences.LogLevel)
    }

    // 3. Notifications service (pub/sub, no dependencies)
    s.notifService = notifications.NewService()

    // 4. FS service (depends on database via adapter)
    fsCfg := cfg.ToFSConfig()
    fsCfg.DB = fs.NewDBAdapter()
    s.fsService = fs.NewService(fsCfg)

    // 5. Digest worker (depends on database + notifications)
    s.digestWorker = digest.NewWorker(cfg.ToDigestConfig(), s.database, s.notifService)

    // 6. Wire service connections
    s.connectServices()

    // 7. Setup HTTP router
    s.setupRouter()

    return s, nil
}
```

### Service Wiring

Components communicate via callbacks, not direct method calls:

```go
func (s *Server) connectServices() {
    // FS → Digest: When files change, trigger digest processing
    s.fsService.SetFileChangeHandler(func(event fs.FileChangeEvent) {
        if event.ContentChanged {
            s.digestWorker.OnFileChange(event.FilePath, event.IsNew, true)
        }

        // Notify UI of file changes
        if event.IsNew || event.ContentChanged {
            s.notifService.NotifyInboxChanged()
        }
    })
}
```

## Router Setup

```go
func (s *Server) setupRouter() {
    // Set Gin mode
    if !s.cfg.IsDevelopment() {
        gin.SetMode(gin.ReleaseMode)
    }

    s.router = gin.New()

    // Middleware stack
    s.router.Use(gin.Recovery())           // Panic recovery
    s.router.Use(log.GinLogger())          // Request logging

    // CORS (development only)
    if s.cfg.IsDevelopment() {
        s.router.Use(s.corsMiddleware())
    }

    // Security headers (production only)
    if !s.cfg.IsDevelopment() {
        s.router.Use(s.securityHeadersMiddleware())
    }

    // Gzip compression (skip streaming endpoints)
    s.router.Use(gzip.Gzip(gzip.DefaultCompression, gzip.WithExcludedPaths([]string{
        "/api/notifications/stream",  // SSE
        "/api/asr/realtime",          // WebSocket
    })))

    s.router.SetTrustedProxies(nil)
}
```

### Middleware Stack

| Middleware | Purpose | Environment |
|------------|---------|-------------|
| `gin.Recovery()` | Panic recovery | All |
| `log.GinLogger()` | Request logging | All |
| `corsMiddleware()` | CORS headers | Development |
| `securityHeadersMiddleware()` | Security headers | Production |
| `gzip.Gzip()` | Response compression | All |

### Security Headers (Production)

```go
func (s *Server) securityHeadersMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        c.Header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        c.Header("X-Content-Type-Options", "nosniff")
        c.Header("X-XSS-Protection", "1; mode=block")
        c.Header("X-Frame-Options", "SAMEORIGIN")
        c.Header("Cross-Origin-Opener-Policy", "same-origin")
        c.Header("Referrer-Policy", "strict-origin-when-cross-origin")
        c.Header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        c.Next()
    }
}
```

### CORS (Development)

```go
func (s *Server) corsMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        origin := c.Request.Header.Get("Origin")
        allowedOrigins := map[string]bool{
            "http://localhost:12345": true,
            "http://localhost:12346": true,
        }

        if allowedOrigins[origin] {
            c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
        }

        c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS")
        c.Writer.Header().Set("Access-Control-Allow-Headers", "Origin, Content-Type, Accept, Authorization, ...")
        c.Writer.Header().Set("Access-Control-Expose-Headers", "Upload-Offset, Upload-Length, Location, Tus-Resumable")

        if c.Request.Method == "OPTIONS" {
            c.AbortWithStatus(http.StatusNoContent)
            return
        }
        c.Next()
    }
}
```

## Starting the Server

```go
func (s *Server) Start() error {
    log.Info().Msg("starting server components")

    // Start FS service (watcher + scanner)
    if err := s.fsService.Start(); err != nil {
        return fmt.Errorf("failed to start FS service: %w", err)
    }

    // Start digest worker (goroutine)
    go s.digestWorker.Start()

    // Create and start HTTP server
    s.http = &http.Server{
        Addr:     fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port),
        Handler:  s.router,
        ErrorLog: log.StdErrorLogger(),
    }

    log.Info().
        Str("addr", s.http.Addr).
        Str("env", s.cfg.Env).
        Msg("HTTP server starting")

    // Blocks until shutdown
    return s.http.ListenAndServe()
}
```

## Graceful Shutdown

Shutdown order is **reverse** of initialization:

```go
func (s *Server) Shutdown(ctx context.Context) error {
    log.Info().Msg("shutting down server")

    // 1. Signal all long-running handlers (WebSocket, SSE)
    s.shutdownCancel()

    // Give handlers time to process cancellation
    time.Sleep(100 * time.Millisecond)

    // 2. Close notification service (disconnect SSE clients)
    s.notifService.Shutdown()

    // 3. Shutdown HTTP server (stop accepting new requests)
    if s.http != nil {
        if err := s.http.Shutdown(ctx); err != nil {
            log.Error().Err(err).Msg("http server shutdown error")
        }
    }

    // 4. Stop background services (reverse order)
    s.digestWorker.Stop()
    s.fsService.Stop()

    // 5. Close database last
    if s.database != nil {
        if err := s.database.Close(); err != nil {
            return err
        }
    }

    log.Info().Msg("server shutdown complete")
    return nil
}
```

### Shutdown Context for Handlers

Long-running handlers (WebSocket, SSE) should listen to the shutdown context:

```go
func (h *Handlers) SomeStreamingHandler(c *gin.Context) {
    for {
        select {
        case <-h.server.ShutdownContext().Done():
            // Server is shutting down, exit gracefully
            return

        case <-c.Request.Context().Done():
            // Client disconnected
            return

        case msg := <-messages:
            // Handle message
        }
    }
}
```

## Component Accessors

API handlers access components through these methods:

```go
func (s *Server) DB() *db.DB                             { return s.database }
func (s *Server) FS() *fs.Service                        { return s.fsService }
func (s *Server) Digest() *digest.Worker                 { return s.digestWorker }
func (s *Server) Notifications() *notifications.Service  { return s.notifService }
func (s *Server) Router() *gin.Engine                    { return s.router }
func (s *Server) ShutdownContext() context.Context       { return s.shutdownCtx }
```

## Configuration

```go
// backend/server/config.go
type Config struct {
    // Server
    Host string
    Port int
    Env  string  // "development" or "production"

    // Data directories
    UserDataDir string
    AppDataDir  string

    // External services
    MeiliHost   string
    QdrantHost  string
    OpenAIAPIKey string
    // ... etc
}

func (c *Config) IsDevelopment() bool {
    return c.Env != "production"
}

// Conversion methods for sub-component configs
func (c *Config) ToDBConfig() db.Config { ... }
func (c *Config) ToFSConfig() fs.Config { ... }
func (c *Config) ToDigestConfig() digest.Config { ... }
```

## Adding a New Component

1. **Add field to Server struct**:
   ```go
   type Server struct {
       // ...
       myNewService *mypackage.Service
   }
   ```

2. **Initialize in New() after dependencies**:
   ```go
   // After database, notifications, etc. as appropriate
   s.myNewService = mypackage.NewService(...)
   ```

3. **Wire event handlers if needed**:
   ```go
   func (s *Server) connectServices() {
       // ... existing wiring ...
       s.myNewService.SetHandler(...)
   }
   ```

4. **Add accessor method**:
   ```go
   func (s *Server) MyNewService() *mypackage.Service { return s.myNewService }
   ```

5. **Stop in Shutdown() (reverse order)**:
   ```go
   func (s *Server) Shutdown(ctx context.Context) error {
       // ... existing shutdown ...
       s.myNewService.Stop()  // Before services it depends on
   }
   ```

## Files to Modify

| Task | Files |
|------|-------|
| Add new component | `backend/server/server.go` |
| Change initialization order | `backend/server/server.go` New() |
| Add middleware | `backend/server/server.go` setupRouter() |
| Change configuration | `backend/server/config.go` |
