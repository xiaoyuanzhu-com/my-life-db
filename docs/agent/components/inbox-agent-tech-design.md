# Inbox Agent - Technical Design

This document describes the technical implementation of the inbox agent system, focusing on how it integrates with the existing digest workflow.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              INBOX FLOW                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │   File      │    │   Digest    │    │   Agent     │    │   User      │ │
│  │   Added     │───▶│   Worker    │───▶│   Router    │───▶│   Response  │ │
│  │             │    │  (existing) │    │   (new)     │    │             │ │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘ │
│                                                                             │
│  Existing flow ──────────────────┘                                          │
│  New flow ───────────────────────────────────────────┘                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key principle:** The digest workflow remains unchanged. We add a hook that fires after all digests complete for a file, which triggers the agent system.

---

## Trigger: Digest Completion Hook

### Current Digest Flow (unchanged)

```go
// backend/workers/digest/worker.go (existing)

func (w *Worker) processFile(filePath string) {
    for _, digester := range w.digesters {
        w.runDigester(filePath, digester)
    }
    // Currently: nothing happens after all digesters complete
}
```

### New: Add Completion Callback

```go
// backend/workers/digest/worker.go (modified)

type Worker struct {
    // ... existing fields ...

    // New: callback when ALL digests complete for a file
    onFileDigestsComplete func(filePath string, digests []DigestResult)
}

func (w *Worker) SetFileDigestsCompleteHandler(handler func(string, []DigestResult)) {
    w.onFileDigestsComplete = handler
}

func (w *Worker) processFile(filePath string) {
    results := make([]DigestResult, 0)

    for _, digester := range w.digesters {
        result := w.runDigester(filePath, digester)
        results = append(results, result)
    }

    // NEW: Trigger completion callback
    if w.onFileDigestsComplete != nil {
        w.onFileDigestsComplete(filePath, results)
    }
}
```

### Wiring in Server

```go
// backend/server/server.go

func New(cfg *Config) (*Server, error) {
    // ... existing initialization ...

    // Wire digest completion to agent system
    s.digestWorker.SetFileDigestsCompleteHandler(func(filePath string, digests []DigestResult) {
        // Only trigger for inbox files
        if !strings.HasPrefix(filePath, "inbox/") {
            return
        }

        // Queue for agent processing
        s.agentWorker.OnNewInboxFile(filePath, digests)
    })
}
```

---

## Agent Worker

A new background worker that processes inbox files through the agent system.

### Worker Structure

```go
// backend/agent/worker.go

type Worker struct {
    db           *db.DB
    router       *Router
    registry     *Registry
    notif        *notifications.Service

    queue        chan AgentTask
    shutdownCh   chan struct{}
    wg           sync.WaitGroup
}

type AgentTask struct {
    Type     TaskType
    FilePath string
    Digests  []DigestResult
    Message  string           // For user-initiated tasks
    ConvID   string           // Conversation context
}

type TaskType string
const (
    TaskTypeNewFile     TaskType = "new_file"      // Auto-triggered by digest completion
    TaskTypeUserMessage TaskType = "user_message"  // User sent a message
)

func NewWorker(cfg WorkerConfig) *Worker {
    w := &Worker{
        db:         cfg.DB,
        router:     cfg.Router,
        registry:   cfg.Registry,
        notif:      cfg.Notif,
        queue:      make(chan AgentTask, 100),
        shutdownCh: make(chan struct{}),
    }
    return w
}

func (w *Worker) Start() {
    w.wg.Add(1)
    go w.processLoop()
}

func (w *Worker) Stop() {
    close(w.shutdownCh)
    w.wg.Wait()
}
```

### Processing Loop

```go
func (w *Worker) processLoop() {
    defer w.wg.Done()

    for {
        select {
        case task := <-w.queue:
            w.processTask(task)

        case <-w.shutdownCh:
            return
        }
    }
}

func (w *Worker) processTask(task AgentTask) {
    ctx := context.Background()

    switch task.Type {
    case TaskTypeNewFile:
        w.handleNewFile(ctx, task)

    case TaskTypeUserMessage:
        w.handleUserMessage(ctx, task)
    }
}
```

### New File Handler (Auto-Organization)

```go
func (w *Worker) handleNewFile(ctx context.Context, task AgentTask) {
    log.Info().Str("file", task.FilePath).Msg("processing new inbox file")

    // Check if auto-organization is enabled
    settings := w.db.GetSettings()
    if !settings.AutoOrganize {
        return
    }

    // Get or create conversation for this file
    conv := w.getOrCreateFileConversation(ctx, task.FilePath)

    // Build context from digests
    fileContext := w.buildFileContext(task.FilePath, task.Digests)

    // ════════════════════════════════════════════════════════════════════
    // STAGE 1: Router decides intent (for new files, it's always "organize")
    // ════════════════════════════════════════════════════════════════════
    // For auto-triggered files, we skip the router and go directly to organize
    // But we could use the router if we want to support other auto-actions

    intent := IntentOrganize

    // ════════════════════════════════════════════════════════════════════
    // STAGE 2: Run Organize Agent
    // ════════════════════════════════════════════════════════════════════

    agent, _ := w.registry.GetAgent(intent)

    response, err := agent.Handle(ctx, AgentRequest{
        Message:      "", // No user message for auto-triggered
        Intent:       intent,
        FilePath:     task.FilePath,
        FileContext:  fileContext,
        Conversation: w.getConversationContext(conv.ID),
        AutoTriggered: true,
    })

    if err != nil {
        log.Error().Err(err).Str("file", task.FilePath).Msg("agent failed")
        return
    }

    // Save agent messages to conversation
    for _, msg := range response.Messages {
        w.saveMessage(ctx, conv.ID, "agent", msg)
    }

    // Notify UI of new suggestion
    if hasSuggestion(response) {
        w.notif.NotifyInboxSuggestion(task.FilePath, response.Suggestion)
    }
}
```

### User Message Handler

```go
func (w *Worker) handleUserMessage(ctx context.Context, task AgentTask) {
    log.Info().Str("message", task.Message).Msg("processing user message")

    // Get conversation context
    convCtx := w.getConversationContext(task.ConvID)

    // ════════════════════════════════════════════════════════════════════
    // STAGE 1: Fast Router (~150ms)
    // ════════════════════════════════════════════════════════════════════

    routerOutput, err := w.router.Classify(ctx, RouterInput{
        Message:       task.Message,
        Context:       convCtx,
        PendingAction: w.getPendingSuggestion(task.ConvID),
    })

    if err != nil {
        log.Error().Err(err).Msg("router failed, falling back to chat")
        routerOutput = &RouterOutput{Intent: IntentChat, Confidence: 0.5}
    }

    // ════════════════════════════════════════════════════════════════════
    // Handle simple intents (no agent needed)
    // ════════════════════════════════════════════════════════════════════

    switch routerOutput.Intent {
    case IntentConfirm:
        w.executeConfirm(ctx, task.ConvID)
        return

    case IntentReject:
        w.executeReject(ctx, task.ConvID)
        return

    case IntentSave:
        // Pure data - save and trigger organization
        w.handleSave(ctx, task.ConvID, task.Message)
        return

    case IntentChat:
        w.handleChat(ctx, task.ConvID, task.Message)
        return
    }

    // ════════════════════════════════════════════════════════════════════
    // STAGE 2: Specialized Agent (~1-5s)
    // ════════════════════════════════════════════════════════════════════

    agent, ok := w.registry.GetAgent(routerOutput.Intent)
    if !ok {
        log.Error().Str("intent", string(routerOutput.Intent)).Msg("no agent for intent")
        return
    }

    response, err := agent.Handle(ctx, AgentRequest{
        Message:      task.Message,
        Intent:       routerOutput.Intent,
        Params:       routerOutput.Params,
        Conversation: convCtx,
    })

    if err != nil {
        log.Error().Err(err).Msg("agent failed")
        // Save error message
        w.saveMessage(ctx, task.ConvID, "agent", ErrorMessage(err))
        return
    }

    // Save agent response
    for _, msg := range response.Messages {
        w.saveMessage(ctx, task.ConvID, "agent", msg)
    }

    // Execute any actions
    for _, action := range response.Actions {
        w.executeAction(ctx, task.ConvID, action)
    }

    // Notify UI
    w.notif.NotifyConversationUpdated(task.ConvID)
}

// Public method for API to queue user messages
func (w *Worker) QueueUserMessage(convID, message string) {
    w.queue <- AgentTask{
        Type:    TaskTypeUserMessage,
        Message: message,
        ConvID:  convID,
    }
}

// Public method for digest completion hook
func (w *Worker) OnNewInboxFile(filePath string, digests []DigestResult) {
    w.queue <- AgentTask{
        Type:     TaskTypeNewFile,
        FilePath: filePath,
        Digests:  digests,
    }
}
```

---

## Router Implementation

### Fast Intent Classifier

```go
// backend/agent/router/router.go

type Router struct {
    model    string // e.g., "gpt-4o-mini"
    openai   *vendors.OpenAI

    // Cache for common patterns
    cache    *lru.Cache
}

type RouterInput struct {
    Message       string
    Context       *ConversationContext
    PendingAction *Suggestion
}

type RouterOutput struct {
    Intent     IntentType
    Confidence float64
    Params     map[string]string
}

func (r *Router) Classify(ctx context.Context, input RouterInput) (*RouterOutput, error) {
    // ──────────────────────────────────────────────────────────────────
    // Fast path 1: Check cache for exact matches
    // ──────────────────────────────────────────────────────────────────
    cacheKey := r.cacheKey(input)
    if cached, ok := r.cache.Get(cacheKey); ok {
        return cached.(*RouterOutput), nil
    }

    // ──────────────────────────────────────────────────────────────────
    // Fast path 2: Pending action + affirmative/negative response
    // ──────────────────────────────────────────────────────────────────
    if input.PendingAction != nil {
        if r.isAffirmative(input.Message) {
            return &RouterOutput{Intent: IntentConfirm, Confidence: 0.95}, nil
        }
        if r.isNegative(input.Message) {
            return &RouterOutput{Intent: IntentReject, Confidence: 0.95}, nil
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Fast path 3: Pure data (URL, file reference, long text without ?)
    // ──────────────────────────────────────────────────────────────────
    if r.isPureData(input.Message) {
        return &RouterOutput{Intent: IntentSave, Confidence: 0.9}, nil
    }

    // ──────────────────────────────────────────────────────────────────
    // LLM classification for ambiguous cases
    // ──────────────────────────────────────────────────────────────────
    output, err := r.llmClassify(ctx, input)
    if err != nil {
        return nil, err
    }

    // Cache the result
    r.cache.Add(cacheKey, output)

    return output, nil
}

func (r *Router) isAffirmative(msg string) bool {
    msg = strings.ToLower(strings.TrimSpace(msg))
    affirmatives := []string{
        "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "k",
        "do it", "go ahead", "proceed", "confirm", "move it",
        "sounds good", "looks good", "perfect", "great", "👍",
    }
    for _, a := range affirmatives {
        if msg == a || strings.HasPrefix(msg, a+" ") {
            return true
        }
    }
    return false
}

func (r *Router) isNegative(msg string) bool {
    msg = strings.ToLower(strings.TrimSpace(msg))
    negatives := []string{
        "no", "nope", "nah", "cancel", "stop", "don't", "dont",
        "keep it", "leave it", "skip", "ignore", "never mind", "👎",
    }
    for _, n := range negatives {
        if msg == n || strings.HasPrefix(msg, n+" ") {
            return true
        }
    }
    return false
}

func (r *Router) isPureData(msg string) bool {
    // URL pattern
    if strings.HasPrefix(msg, "http://") || strings.HasPrefix(msg, "https://") {
        return true
    }

    // Long text without question indicators
    if len(msg) > 200 && !strings.Contains(msg, "?") {
        questionWords := []string{"find", "search", "where", "what", "how", "show", "get"}
        msgLower := strings.ToLower(msg)
        for _, qw := range questionWords {
            if strings.HasPrefix(msgLower, qw+" ") {
                return false
            }
        }
        return true
    }

    return false
}
```

### LLM Classification

```go
func (r *Router) llmClassify(ctx context.Context, input RouterInput) (*RouterOutput, error) {
    prompt := r.buildPrompt(input)

    resp, err := r.openai.Complete(ctx, vendors.OpenAIRequest{
        Model:       r.model,
        Messages:    []vendors.Message{{Role: "user", Content: prompt}},
        Temperature: 0,
        MaxTokens:   100,
        ResponseFormat: &vendors.ResponseFormat{Type: "json_object"},
    })
    if err != nil {
        return nil, fmt.Errorf("llm classify: %w", err)
    }

    var result struct {
        Intent     string            `json:"intent"`
        Confidence float64           `json:"confidence"`
        Params     map[string]string `json:"params"`
    }
    if err := json.Unmarshal([]byte(resp), &result); err != nil {
        return nil, fmt.Errorf("parse response: %w", err)
    }

    return &RouterOutput{
        Intent:     IntentType(result.Intent),
        Confidence: result.Confidence,
        Params:     result.Params,
    }, nil
}

func (r *Router) buildPrompt(input RouterInput) string {
    var sb strings.Builder

    sb.WriteString(`You are an intent classifier for a personal file management system.

## Intents
- query: User wants to FIND files, ASK questions, GET information, or SUMMARIZE content
- organize: User wants to MOVE, ORGANIZE, or SORT files into folders
- save: User is ADDING new data without asking anything (just text, URL, or file)
- confirm: User is saying YES to a pending suggestion
- reject: User is saying NO to a pending suggestion
- chat: Greetings, thanks, or completely unclear intent

`)

    // Add context
    if input.Context != nil && len(input.Context.RecentMessages) > 0 {
        sb.WriteString("## Recent Conversation\n")
        for _, msg := range input.Context.RecentMessages {
            sb.WriteString(fmt.Sprintf("- %s: %s\n", msg.Role, truncate(msg.Content, 100)))
        }
        sb.WriteString("\n")
    }

    // Add pending action
    if input.PendingAction != nil {
        sb.WriteString(fmt.Sprintf("## Pending Action\nSuggestion to move '%s' to '%s'\n\n",
            input.PendingAction.FileName,
            input.PendingAction.TargetFolder))
    } else {
        sb.WriteString("## Pending Action\nNone\n\n")
    }

    // Add user message
    sb.WriteString(fmt.Sprintf("## User Message\n\"%s\"\n\n", input.Message))

    // Output format
    sb.WriteString(`## Output
Respond with JSON only:
{"intent": "query|organize|save|confirm|reject|chat", "confidence": 0.0-1.0, "params": {}}

For "query", include "search_query" in params if clear.
For "organize", include "target_folder" in params if mentioned.`)

    return sb.String()
}
```

---

## Agent Implementations

### Base Agent with Tool Calling

```go
// backend/agent/base.go

type BaseAgent struct {
    name     string
    model    string
    openai   *vendors.OpenAI
    tools    []Tool
    prompt   string
}

func (a *BaseAgent) Handle(ctx context.Context, req AgentRequest) (*AgentResponse, error) {
    messages := a.buildMessages(req)
    toolSchemas := a.getToolSchemas()

    response := &AgentResponse{
        Messages: make([]ResponseMessage, 0),
        Actions:  make([]Action, 0),
    }

    // Agent loop: keep calling LLM until it stops using tools
    for turn := 0; turn < 10; turn++ {
        completion, err := a.openai.CompleteWithTools(ctx, vendors.OpenAIRequest{
            Model:       a.model,
            Messages:    messages,
            Tools:       toolSchemas,
            Temperature: 0.3,
            MaxTokens:   4096,
        })
        if err != nil {
            return nil, fmt.Errorf("llm completion: %w", err)
        }

        // Check if LLM wants to call tools
        if len(completion.ToolCalls) == 0 {
            // No more tools, we're done
            if completion.Content != "" {
                response.Messages = append(response.Messages, ResponseMessage{
                    Type:    "text",
                    Content: TextContent{Text: completion.Content},
                })
            }
            break
        }

        // Execute tool calls
        toolResults := make([]vendors.ToolResult, 0)
        for _, call := range completion.ToolCalls {
            tool := a.getTool(call.Name)
            if tool == nil {
                toolResults = append(toolResults, vendors.ToolResult{
                    ID:    call.ID,
                    Error: fmt.Sprintf("unknown tool: %s", call.Name),
                })
                continue
            }

            result, err := tool.Execute(ctx, call.Arguments)
            if err != nil {
                toolResults = append(toolResults, vendors.ToolResult{
                    ID:    call.ID,
                    Error: err.Error(),
                })
                continue
            }

            toolResults = append(toolResults, vendors.ToolResult{
                ID:     call.ID,
                Result: result,
            })

            // Check if tool produced a response message
            if rm, ok := result.(ResponseMessage); ok {
                response.Messages = append(response.Messages, rm)
            }

            // Check if tool produced an action
            if action, ok := result.(Action); ok {
                response.Actions = append(response.Actions, action)
            }
        }

        // Add assistant message and tool results to conversation
        messages = append(messages, vendors.Message{
            Role:      "assistant",
            ToolCalls: completion.ToolCalls,
        })
        messages = append(messages, vendors.Message{
            Role:        "tool",
            ToolResults: toolResults,
        })
    }

    return response, nil
}
```

### Query Agent

```go
// backend/agent/query/agent.go

func NewQueryAgent(cfg AgentConfig) *QueryAgent {
    return &QueryAgent{
        BaseAgent: BaseAgent{
            name:   "query",
            model:  cfg.Model,
            openai: cfg.OpenAI,
            tools: []Tool{
                NewSearchFilesTool(cfg.Search),
                NewGetFileContentTool(cfg.DB),
                NewListRecentFilesTool(cfg.DB),
                NewRespondToUserTool(),
            },
            prompt: queryAgentPrompt,
        },
        search: cfg.Search,
        db:     cfg.DB,
    }
}

var queryAgentPrompt = `You are a helpful assistant for a personal file database.
You help users find files and answer questions about their data.

## Your Capabilities
- Search files by content, name, tags, or description
- Read and summarize file contents
- Answer questions about the user's data
- Provide statistics and insights

## Guidelines
- Be conversational and helpful
- When you find relevant files, include them in your response
- If a search returns too many results, ask clarifying questions
- If no results found, suggest alternative search terms
- Summarize long content when appropriate

## IMPORTANT
Always call respond_to_user at the end with your final answer.
Include file paths in the "files" parameter to show them to the user.
`
```

### Organize Agent

```go
// backend/agent/organize/agent.go

func NewOrganizeAgent(cfg AgentConfig) *OrganizeAgent {
    return &OrganizeAgent{
        BaseAgent: BaseAgent{
            name:   "organize",
            model:  cfg.Model,
            openai: cfg.OpenAI,
            tools: []Tool{
                NewGetFolderTreeTool(cfg.FS),
                NewReadGuidelineTool(cfg.FS),
                NewGetFileInfoTool(cfg.DB),
                NewSuggestOrganizationTool(cfg.DB),
                NewRespondToUserTool(),
            },
            prompt: organizeAgentPrompt,
        },
        fs: cfg.FS,
        db: cfg.DB,
    }
}

var organizeAgentPrompt = `You are an organization assistant for a personal file database.
You help organize inbox files into the appropriate library folders.

## Your Workflow
1. ALWAYS call read_guideline first to understand the user's organization patterns
2. Call get_folder_tree to see available destinations
3. If you have file content, analyze it to understand what the file is
4. Call suggest_organization with your recommendation

## Guidelines
- Respect the user's existing patterns (from guideline.md)
- Explain your reasoning clearly and briefly
- Reference patterns from guideline.md when possible
- If you're unsure, say so and offer alternatives

## Confidence Levels
- High (>0.9): Clear match to existing pattern, minimal explanation needed
- Medium (0.7-0.9): Good match, explain your reasoning
- Low (<0.7): Uncertain, ask user for guidance or suggest "keep in inbox"

## IMPORTANT
- Always call read_guideline before making suggestions
- Always end with suggest_organization or respond_to_user
`
```

---

## Tools

### Search Files Tool

```go
// backend/agent/tools/search.go

type SearchFilesTool struct {
    search *SearchService
}

func (t *SearchFilesTool) Name() string { return "search_files" }

func (t *SearchFilesTool) Schema() vendors.ToolSchema {
    return vendors.ToolSchema{
        Name:        "search_files",
        Description: "Search for files by content, name, or description. Returns matching files with relevance scores.",
        Parameters: map[string]vendors.ParameterSchema{
            "query": {
                Type:        "string",
                Description: "Search query - can be keywords, phrases, or natural language",
                Required:    true,
            },
            "type": {
                Type:        "string",
                Description: "Filter by mime type prefix (e.g., 'image/', 'application/pdf', 'text/')",
            },
            "folder": {
                Type:        "string",
                Description: "Limit search to a specific folder path",
            },
            "limit": {
                Type:        "integer",
                Description: "Maximum number of results (default 10, max 50)",
            },
        },
    }
}

func (t *SearchFilesTool) Execute(ctx context.Context, args json.RawMessage) (interface{}, error) {
    var params struct {
        Query  string `json:"query"`
        Type   string `json:"type"`
        Folder string `json:"folder"`
        Limit  int    `json:"limit"`
    }
    if err := json.Unmarshal(args, &params); err != nil {
        return nil, err
    }

    if params.Limit == 0 {
        params.Limit = 10
    }
    if params.Limit > 50 {
        params.Limit = 50
    }

    results, err := t.search.Search(ctx, SearchRequest{
        Query:  params.Query,
        Type:   params.Type,
        Path:   params.Folder,
        Limit:  params.Limit,
        Types:  []string{"keyword", "semantic"},
    })
    if err != nil {
        return nil, err
    }

    // Format for LLM
    var sb strings.Builder
    sb.WriteString(fmt.Sprintf("Found %d results for '%s':\n\n", len(results.Results), params.Query))

    for i, r := range results.Results {
        sb.WriteString(fmt.Sprintf("%d. %s\n", i+1, r.Path))
        sb.WriteString(fmt.Sprintf("   Type: %s, Size: %s\n", r.MimeType, formatSize(r.Size)))
        if r.MatchContext != "" {
            sb.WriteString(fmt.Sprintf("   Match: %s\n", truncate(r.MatchContext, 200)))
        }
        sb.WriteString("\n")
    }

    return sb.String(), nil
}
```

### Suggest Organization Tool

```go
// backend/agent/tools/suggest.go

type SuggestOrganizationTool struct {
    db *db.DB
}

func (t *SuggestOrganizationTool) Name() string { return "suggest_organization" }

func (t *SuggestOrganizationTool) Schema() vendors.ToolSchema {
    return vendors.ToolSchema{
        Name:        "suggest_organization",
        Description: "Suggest moving a file to a folder. Creates a pending suggestion for the user to confirm.",
        Parameters: map[string]vendors.ParameterSchema{
            "file_path": {
                Type:        "string",
                Description: "The file path to move",
                Required:    true,
            },
            "target_folder": {
                Type:        "string",
                Description: "The target folder path (must exist)",
                Required:    true,
            },
            "reasoning": {
                Type:        "string",
                Description: "Brief explanation of why this folder is appropriate (1-2 sentences)",
                Required:    true,
            },
            "confidence": {
                Type:        "number",
                Description: "Confidence score 0.0-1.0",
                Required:    true,
            },
        },
    }
}

func (t *SuggestOrganizationTool) Execute(ctx context.Context, args json.RawMessage) (interface{}, error) {
    var params struct {
        FilePath     string  `json:"file_path"`
        TargetFolder string  `json:"target_folder"`
        Reasoning    string  `json:"reasoning"`
        Confidence   float64 `json:"confidence"`
    }
    if err := json.Unmarshal(args, &params); err != nil {
        return nil, err
    }

    // Create suggestion in database
    suggestion := &Suggestion{
        ID:           uuid.New().String(),
        FilePath:     params.FilePath,
        TargetFolder: params.TargetFolder,
        Reasoning:    params.Reasoning,
        Confidence:   params.Confidence,
        Status:       "pending",
        CreatedAt:    time.Now(),
    }

    if err := t.db.CreateSuggestion(ctx, suggestion); err != nil {
        return nil, err
    }

    // Return a ResponseMessage that will be shown to user
    return ResponseMessage{
        Type: "suggestion",
        Content: SuggestionContent{
            SuggestionID: suggestion.ID,
            FilePath:     params.FilePath,
            FileName:     filepath.Base(params.FilePath),
            TargetFolder: params.TargetFolder,
            Reasoning:    params.Reasoning,
            Confidence:   params.Confidence,
        },
    }, nil
}
```

### Read Guideline Tool

```go
// backend/agent/tools/guideline.go

type ReadGuidelineTool struct {
    fs *fs.Service
}

func (t *ReadGuidelineTool) Name() string { return "read_guideline" }

func (t *ReadGuidelineTool) Schema() vendors.ToolSchema {
    return vendors.ToolSchema{
        Name:        "read_guideline",
        Description: "Read the user's guideline.md file to understand their organization patterns and folder structure.",
        Parameters:  map[string]vendors.ParameterSchema{},
    }
}

func (t *ReadGuidelineTool) Execute(ctx context.Context, args json.RawMessage) (interface{}, error) {
    content, err := t.fs.ReadFile("guideline.md")
    if err != nil {
        return "No guideline.md file found. Suggest organizing based on file type and content.", nil
    }

    return fmt.Sprintf("User's organization guidelines:\n\n%s", content), nil
}
```

---

## Database Schema

### New Tables

```sql
-- Migration: 00X_agent_tables.sql

-- Conversations in inbox
CREATE TABLE inbox_conversations (
    id              TEXT PRIMARY KEY,
    file_path       TEXT,                           -- Associated file (NULL for general conversations)
    status          TEXT NOT NULL DEFAULT 'active', -- active, completed, archived
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_inbox_conversations_file ON inbox_conversations(file_path);
CREATE INDEX idx_inbox_conversations_status ON inbox_conversations(status, updated_at DESC);

-- Messages in conversations
CREATE TABLE inbox_messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id),
    role            TEXT NOT NULL,  -- user, agent, system
    type            TEXT NOT NULL,  -- text, suggestion, search_result, action_result, etc.
    content         TEXT NOT NULL,  -- JSON content
    metadata        TEXT,           -- JSON metadata (tokens, model, timing)
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_inbox_messages_conv ON inbox_messages(conversation_id, created_at);

-- Pending organization suggestions
CREATE TABLE organization_suggestions (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES inbox_conversations(id),
    message_id      TEXT REFERENCES inbox_messages(id),
    file_path       TEXT NOT NULL,
    target_folder   TEXT NOT NULL,
    reasoning       TEXT NOT NULL,
    confidence      REAL NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending', -- pending, accepted, rejected, expired
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at     DATETIME
);

CREATE INDEX idx_suggestions_status ON organization_suggestions(status, created_at DESC);
CREATE INDEX idx_suggestions_file ON organization_suggestions(file_path);
```

---

## API Endpoints

### Send Message

```go
// POST /api/inbox/messages
func (h *Handlers) SendInboxMessage(c *gin.Context) {
    var req struct {
        Message        string `json:"message" binding:"required"`
        ConversationID string `json:"conversation_id"` // Optional, creates new if empty
    }
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(400, gin.H{"error": err.Error()})
        return
    }

    // Get or create conversation
    var convID string
    if req.ConversationID != "" {
        convID = req.ConversationID
    } else {
        conv, err := h.createConversation(c.Request.Context(), nil)
        if err != nil {
            c.JSON(500, gin.H{"error": "failed to create conversation"})
            return
        }
        convID = conv.ID
    }

    // Save user message
    userMsg, err := h.saveMessage(c.Request.Context(), convID, "user", MessageContent{
        Type:    "text",
        Content: TextContent{Text: req.Message},
    })
    if err != nil {
        c.JSON(500, gin.H{"error": "failed to save message"})
        return
    }

    // Queue for agent processing
    h.server.AgentWorker().QueueUserMessage(convID, req.Message)

    // Return immediately - agent will process async
    c.JSON(202, gin.H{
        "conversation_id": convID,
        "message_id":      userMsg.ID,
        "status":          "processing",
    })
}
```

### Get Conversation

```go
// GET /api/inbox/conversations/:id
func (h *Handlers) GetInboxConversation(c *gin.Context) {
    convID := c.Param("id")

    conv, err := h.db.GetConversation(c.Request.Context(), convID)
    if err != nil {
        c.JSON(404, gin.H{"error": "conversation not found"})
        return
    }

    messages, err := h.db.GetConversationMessages(c.Request.Context(), convID, 50)
    if err != nil {
        c.JSON(500, gin.H{"error": "failed to get messages"})
        return
    }

    c.JSON(200, gin.H{
        "conversation": conv,
        "messages":     messages,
    })
}
```

### Respond to Suggestion

```go
// POST /api/inbox/suggestions/:id/respond
func (h *Handlers) RespondToSuggestion(c *gin.Context) {
    suggestionID := c.Param("id")

    var req struct {
        Action       string `json:"action" binding:"required,oneof=accept reject choose"`
        TargetFolder string `json:"target_folder"` // Required if action=choose
    }
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(400, gin.H{"error": err.Error()})
        return
    }

    ctx := c.Request.Context()

    suggestion, err := h.db.GetSuggestion(ctx, suggestionID)
    if err != nil {
        c.JSON(404, gin.H{"error": "suggestion not found"})
        return
    }

    if suggestion.Status != "pending" {
        c.JSON(400, gin.H{"error": "suggestion already resolved"})
        return
    }

    switch req.Action {
    case "accept":
        // Move file to suggested folder
        err = h.server.FS().MoveFile(suggestion.FilePath, suggestion.TargetFolder)
        if err != nil {
            c.JSON(500, gin.H{"error": "failed to move file"})
            return
        }
        h.db.UpdateSuggestionStatus(ctx, suggestionID, "accepted")

    case "reject":
        h.db.UpdateSuggestionStatus(ctx, suggestionID, "rejected")

    case "choose":
        if req.TargetFolder == "" {
            c.JSON(400, gin.H{"error": "target_folder required for choose action"})
            return
        }
        // Move to user-chosen folder
        err = h.server.FS().MoveFile(suggestion.FilePath, req.TargetFolder)
        if err != nil {
            c.JSON(500, gin.H{"error": "failed to move file"})
            return
        }
        h.db.UpdateSuggestionStatus(ctx, suggestionID, "accepted")
    }

    // Add result message to conversation
    h.saveMessage(ctx, suggestion.ConversationID, "system", MessageContent{
        Type: "action_result",
        Content: ActionResultContent{
            Action:  req.Action,
            Success: true,
            Details: fmt.Sprintf("File %s", req.Action),
        },
    })

    c.JSON(200, gin.H{"status": "ok"})
}
```

---

## SSE Notifications

```go
// backend/notifications/events.go

const (
    EventInboxSuggestion     = "inbox:suggestion"
    EventConversationUpdated = "inbox:conversation_updated"
)

type InboxSuggestionEvent struct {
    FilePath   string  `json:"file_path"`
    Suggestion *Suggestion `json:"suggestion"`
}

type ConversationUpdatedEvent struct {
    ConversationID string `json:"conversation_id"`
}

// In service
func (s *Service) NotifyInboxSuggestion(filePath string, suggestion *Suggestion) {
    s.broadcast(EventInboxSuggestion, InboxSuggestionEvent{
        FilePath:   filePath,
        Suggestion: suggestion,
    })
}

func (s *Service) NotifyConversationUpdated(convID string) {
    s.broadcast(EventConversationUpdated, ConversationUpdatedEvent{
        ConversationID: convID,
    })
}
```

---

## Configuration

```go
// backend/config/config.go

type AgentConfig struct {
    // Enable/disable
    Enabled      bool `env:"AGENT_ENABLED" default:"true"`
    AutoOrganize bool `env:"AGENT_AUTO_ORGANIZE" default:"false"`

    // Models
    RouterModel string `env:"AGENT_ROUTER_MODEL" default:"gpt-4o-mini"`
    AgentModel  string `env:"AGENT_AGENT_MODEL" default:"gpt-4o"`

    // Limits
    RouterMaxTokens int `env:"AGENT_ROUTER_MAX_TOKENS" default:"100"`
    AgentMaxTokens  int `env:"AGENT_MAX_TOKENS" default:"4096"`
    AgentMaxTurns   int `env:"AGENT_MAX_TURNS" default:"10"`

    // Organization
    OrganizeMinConfidence float64 `env:"AGENT_ORGANIZE_MIN_CONFIDENCE" default:"0.7"`
}
```

---

## Sequence Diagrams

### Auto-Organization Flow

```
┌──────┐     ┌────────┐     ┌────────────┐     ┌────────┐     ┌─────────────┐
│ File │     │ Digest │     │   Agent    │     │Organize│     │     UI      │
│System│     │ Worker │     │   Worker   │     │ Agent  │     │             │
└──┬───┘     └───┬────┘     └─────┬──────┘     └───┬────┘     └──────┬──────┘
   │             │                │                │                  │
   │ File added  │                │                │                  │
   │────────────▶│                │                │                  │
   │             │                │                │                  │
   │             │ Process digests│                │                  │
   │             │───────────────▶│                │                  │
   │             │                │                │                  │
   │             │ onComplete()   │                │                  │
   │             │───────────────▶│                │                  │
   │             │                │                │                  │
   │             │                │ Queue task     │                  │
   │             │                │───────────────▶│                  │
   │             │                │                │                  │
   │             │                │                │ read_guideline() │
   │             │                │                │─────────────────▶│
   │             │                │                │                  │
   │             │                │                │ get_folder_tree()│
   │             │                │                │─────────────────▶│
   │             │                │                │                  │
   │             │                │                │ suggest_org()    │
   │             │                │                │─────────────────▶│
   │             │                │                │                  │
   │             │                │                │ Save suggestion  │
   │             │                │                │─────────────────▶│
   │             │                │                │                  │
   │             │                │                │                  │ SSE: suggestion
   │             │                │                │                  │◀─────────────
   │             │                │                │                  │
```

### User Query Flow

```
┌──────┐     ┌────────┐     ┌────────┐     ┌───────┐     ┌──────┐
│ User │     │  API   │     │ Router │     │ Query │     │Search│
│      │     │        │     │        │     │ Agent │     │      │
└──┬───┘     └───┬────┘     └───┬────┘     └───┬───┘     └──┬───┘
   │             │              │              │             │
   │ "find my    │              │              │             │
   │  ID photo"  │              │              │             │
   │────────────▶│              │              │             │
   │             │              │              │             │
   │             │ Classify()   │              │             │
   │             │─────────────▶│              │             │
   │             │              │              │             │
   │             │ {intent:query│              │             │
   │             │  conf: 0.95} │              │             │
   │             │◀─────────────│              │             │
   │             │              │              │             │
   │             │ Handle()     │              │             │
   │             │─────────────────────────────▶│             │
   │             │              │              │             │
   │             │              │              │ search()    │
   │             │              │              │────────────▶│
   │             │              │              │             │
   │             │              │              │ results     │
   │             │              │              │◀────────────│
   │             │              │              │             │
   │             │              │              │respond()    │
   │             │ Response     │              │             │
   │             │◀─────────────────────────────│             │
   │             │              │              │             │
   │ "Found 3    │              │              │             │
   │  matches"   │              │              │             │
   │◀────────────│              │              │             │
```

---

## Future: Digests as Intentions

As you mentioned, digests could eventually become another "intention" the system handles:

```go
// Future architecture

type Intention string
const (
    IntentionDigest   Intention = "digest"    // Extract content, OCR, transcribe
    IntentionOrganize Intention = "organize"  // Suggest organization
    IntentionQuery    Intention = "query"     // Answer questions
    IntentionChat     Intention = "chat"      // General conversation
)

// Unified pipeline
func (w *Worker) processFile(file string) {
    // All intentions handled by same system
    w.runIntention(IntentionDigest, file)    // Current digest flow
    w.runIntention(IntentionOrganize, file)  // New organization
}
```

This would unify the processing model, but that's a larger refactor for the future.
