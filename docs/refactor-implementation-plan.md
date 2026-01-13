# Server Refactoring Implementation Plan

## Current Status

### Completed ✅
1. Architecture documentation (backend-arch.md, module-interfaces.md)
2. db.Config + db.Open() with backward-compatible db.GetDB()
3. server.Config with module config converters
4. fs.Config extended with ScanInterval and WatchEnabled
5. fs.Service refactored to use Config struct
6. notifications.Service - singleton removed, clean NewService()

### Commits Made
- `534027c` - Phase 1: Module configs and architecture docs
- `bcd8a90` - Notifications singleton removal

### Current Build Status
- ✅ Database module compiles (backward compatible)
- ✅ FS module compiles
- ✅ Notifications module compiles
- ❌ Digest module - needs refactor (1 error: notifications.GetService())
- ❌ Main/API - not yet updated

## Next Steps

### Step 1: Complete Digest Worker Refactor
**Goal**: Remove singleton, accept dependencies explicitly

```go
// workers/digest/worker.go

type Worker struct {
	cfg Config // Store config
	db *db.DB  // Store db instance
	notif *notifications.Service // Store notifications instance

	stopChan   chan struct{}
	wg         sync.WaitGroup
	queue      chan string
	processing sync.Map
}

// NewWorker creates digest worker with dependencies
func NewWorker(cfg Config, database *db.DB, notifService *notifications.Service) *Worker {
	return &Worker{
		cfg:      cfg,
		db:       database,
		notif:    notifService,
		stopChan: make(chan struct{}),
		queue:    make(chan string, cfg.QueueSize),
	}
}

// Remove global variables
// - globalWorker
// - globalWorkerOnce
// - GetWorker()

// Update all places that use notifications.GetService()
// to use w.notif
```

**Files to modify**:
- `workers/digest/worker.go` - constructor, remove singleton
- All digesters that need OpenAI/HAID credentials - get from worker config

**Commit**: `refactor: remove singleton from digest worker`

### Step 2: Create Server Package
**Goal**: Implement the server.Server struct

```go
// server/server.go

type Server struct {
	cfg *Config

	// Components (owned)
	db    *db.DB
	fs    *fs.Service
	digest *digest.Worker
	notif  *notifications.Service
	claude *api.ClaudeManager

	// HTTP
	router *gin.Engine
	http   *http.Server
}

func New(cfg *Config) (*Server, error) {
	s := &Server{cfg: cfg}

	// 1. Open database
	dbCfg := cfg.ToDBConfig()
	database, err := db.Open(dbCfg)
	if err != nil {
		return nil, err
	}
	s.db = database

	// 2. Create notifications service
	s.notif = notifications.NewService()

	// 3. Create FS service
	fsCfg := cfg.ToFSConfig()
	fsCfg.DB = fs.NewDBAdapter() // Uses db.GetDB() internally
	s.fs = fs.NewService(fsCfg)

	// 4. Create digest worker
	digestCfg := cfg.ToDigestConfig()
	s.digest = digest.NewWorker(digestCfg, s.db, s.notif)

	// 5. Wire connections
	s.fs.SetFileChangeHandler(func(event fs.FileChangeEvent) {
		if event.ContentChanged {
			s.digest.OnFileChange(event.FilePath, event.IsNew, true)
		}
		if event.IsNew || event.ContentChanged {
			s.notif.NotifyInboxChanged()
		}
	})

	// 6. Initialize Claude manager
	if err := api.InitClaudeManager(); err != nil {
		return nil, err
	}

	// 7. Setup router
	s.setupRouter()

	return s, nil
}

func (s *Server) Start() error {
	// Start services
	if err := s.fs.Start(); err != nil {
		return err
	}
	go s.digest.Start()

	// Start HTTP
	s.http = &http.Server{
		Addr:    fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port),
		Handler: s.router,
	}

	log.Info().Str("addr", s.http.Addr).Msg("server starting")
	return s.http.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	// Shutdown in reverse order
	if err := s.http.Shutdown(ctx); err != nil {
		log.Error().Err(err).Msg("http shutdown error")
	}

	s.digest.Stop()
	s.fs.Stop()
	s.notif.Shutdown()

	if err := s.db.Close(); err != nil {
		log.Error().Err(err).Msg("database close error")
	}

	return nil
}

func (s *Server) setupRouter() {
	s.router = gin.New()
	s.router.Use(gin.Recovery())

	// TODO: Add middleware based on s.cfg.Env

	// Setup routes with server instance
	handlers := api.NewHandlers(s)
	api.SetupRoutes(s.router, handlers)
}

// Component accessors
func (s *Server) DB() *db.DB { return s.db }
func (s *Server) FS() *fs.Service { return s.fs }
func (s *Server) Digest() *digest.Worker { return s.digest }
func (s *Server) Notifications() *notifications.Service { return s.notif }
```

**Files to create**:
- `server/server.go`

**Commit**: `feat: add Server struct with component lifecycle`

### Step 3: Refactor API Handlers
**Goal**: Make handlers use Server instance

```go
// api/handlers.go (new file)

type Handlers struct {
	server *server.Server
}

func NewHandlers(srv *server.Server) *Handlers {
	return &Handlers{server: srv}
}

// Example: inbox.go
func (h *Handlers) HandleInboxGet(c *gin.Context) {
	fs := h.server.FS()
	db := h.server.DB()

	// Use components...
}

// routes.go
func SetupRoutes(router *gin.Engine, h *Handlers) {
	router.GET("/api/inbox", h.HandleInboxGet)
	router.POST("/api/inbox", h.HandleInboxCreate)
	// ...
}
```

**Files to modify**:
- Create `api/handlers.go`
- Update `api/routes.go`
- Update all handlers in `api/*.go` to become methods on *Handlers

**Commit**: `refactor: convert API handlers to methods on Handlers struct`

### Step 4: Update main.go
**Goal**: Simplify to just create and start server

```go
// main.go

func main() {
	// 1. Initialize logging
	log.Initialize("info")

	// 2. Load server config
	cfg := loadServerConfig()

	// 3. Create server
	srv, err := server.New(cfg)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to create server")
	}

	// 4. Start server
	go func() {
		if err := srv.Start(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server error")
		}
	}()

	// 5. Wait for shutdown signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	// 6. Graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	srv.Shutdown(ctx)

	log.Info().Msg("server stopped")
}

func loadServerConfig() *server.Config {
	return &server.Config{
		Port:            getEnvInt("PORT", 12345),
		Host:            getEnv("HOST", "0.0.0.0"),
		Env:             getEnv("ENV", "development"),
		DataDir:         getEnv("MY_DATA_DIR", "./data"),
		DatabasePath:    // compute from DataDir
		FSScanInterval:  1 * time.Hour,
		FSWatchEnabled:  true,
		DigestWorkers:   3,
		DigestQueueSize: 1000,
		OpenAIAPIKey:    getEnv("OPENAI_API_KEY", ""),
		// ... all other config
	}
}
```

**Files to modify**:
- `main.go` - complete rewrite

**Commit**: `refactor: simplify main.go to use Server`

### Step 5: Clean Up Old Patterns
**Goal**: Remove backward compatibility code

- Remove `fs.GetService()` - no longer needed
- Remove `digest.GetWorker()` - no longer needed
- Consider removing `db.GetDB()` if all callers updated (optional)

**Commit**: `refactor: remove singleton compatibility functions`

### Step 6: Testing
**Goal**: Verify everything works

1. Build and run the server
2. Test key flows:
   - File upload
   - Digest processing
   - SSE notifications
3. Fix any runtime issues

**Commit**: `fix: address integration issues`

### Step 7: Documentation
**Goal**: Update project documentation

- Update `CLAUDE.md` with new patterns
- Add examples of how to access services
- Document the Server-based architecture

**Commit**: `docs: update CLAUDE.md with server architecture`

## Execution Order

1. ✅ Digest worker refactor (Step 1)
2. ✅ Server struct implementation (Step 2)
3. ✅ API handlers refactor (Step 3)
4. ✅ main.go update (Step 4)
5. Clean up (Step 5)
6. Testing (Step 6)
7. Documentation (Step 7)

## Risk Mitigation

- Each step is a separate commit - easy to roll back
- Keep backward compatibility where needed
- Test build after each major change
- Server can be tested in isolation before integrating with handlers

## Time Estimate

- Step 1: 30 minutes
- Step 2: 45 minutes
- Step 3: 1-2 hours (many handlers to update)
- Step 4: 15 minutes
- Step 5-7: 30 minutes

**Total**: ~3-4 hours of careful, systematic refactoring
