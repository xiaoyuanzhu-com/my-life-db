# Inbox Agent Architecture v2
## Using Anthropic's Tool Use Pattern

This document describes a simplified architecture that leverages **Claude's native tool use** instead of building a custom skill system.

---

## Core Principle

**Reuse the agent pattern that already works** (like Claude API's tool use), rather than inventing a new skill system.

The agent is:
- A **separate logical entity** that lives alongside the app
- Uses the app's capabilities through a clean **AppClient** interface
- Communicates via **Anthropic's tool use protocol** (or OpenAI's function calling)
- Independent enough to be extracted to a service later

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              THE APP                                         │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         App Backend                                    │ │
│  │                                                                        │ │
│  │   Files │ Search │ Library │ Digest │ FS Service │ Database           │ │
│  │                                                                        │ │
│  │   ┌──────────────────────────────────────────────────────────────────┐│ │
│  │   │                       AppClient Interface                        ││ │
│  │   │  (The app's capabilities exposed as simple methods)              ││ │
│  │   │                                                                  ││ │
│  │   │  search(query) → results                                         ││ │
│  │   │  getFile(path) → file+digests                                    ││ │
│  │   │  getFolderTree() → tree                                          ││ │
│  │   │  moveFile(from, to) → ok                                         ││ │
│  │   │  readGuideline() → text                                          ││ │
│  │   └──────────────────────────────────────────────────────────────────┘│ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                  ▲                                          │
│                                  │ AppClient calls                          │
│                                  │                                          │
│  ┌───────────────────────────────┴──────────────────────────────────────┐  │
│  │                          Agent Runtime                                │  │
│  │                   (Uses Anthropic's tool use pattern)                 │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │  │
│  │  │  Conversation Loop                                               │ │  │
│  │  │                                                                   │ │  │
│  │  │  1. Receive user message                                         │ │  │
│  │  │  2. Build messages array with conversation history               │ │  │
│  │  │  3. Call Claude/GPT with tools=[search, organize, getFile, ...]  │ │  │
│  │  │  4. Execute tool calls via AppClient                             │ │  │
│  │  │  5. Add tool results to messages                                 │ │  │
│  │  │  6. Repeat until agent responds without tools                    │ │  │
│  │  │  7. Return final response                                        │ │  │
│  │  └─────────────────────────────────────────────────────────────────┘ │  │
│  │                                                                       │  │
│  │  Tools (map directly to AppClient methods):                          │  │
│  │  - search                                                             │  │
│  │  - get_file                                                           │  │
│  │  - get_folder_tree                                                    │  │
│  │  - read_guideline                                                     │  │
│  │  - move_file                                                          │  │
│  │  - create_suggestion                                                  │  │
│  │  - list_recent_files                                                  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## The AppClient Interface

This is the **contract** between the agent and the app. The agent only accesses the app through this.

```go
// backend/agent/appclient/client.go

// AppClient defines how the agent interacts with MyLifeDB
// This interface could be implemented via direct calls (LocalClient)
// or via HTTP (RemoteClient) for service deployment
type AppClient interface {
    // ──────────────────────────────────────────────────────────────
    // SEARCH & RETRIEVAL
    // ──────────────────────────────────────────────────────────────

    // Search for files using keyword + semantic search
    Search(ctx context.Context, req SearchRequest) (*SearchResult, error)

    // Get file metadata and digests
    GetFile(ctx context.Context, path string) (*FileWithDigests, error)

    // List recently added files
    ListRecentFiles(ctx context.Context, limit int, mimeTypePrefix string) ([]FileSummary, error)

    // ──────────────────────────────────────────────────────────────
    // ORGANIZATION
    // ──────────────────────────────────────────────────────────────

    // Get folder tree structure
    GetFolderTree(ctx context.Context, depth int) (*FolderNode, error)

    // Read user's organization guideline
    ReadGuideline(ctx context.Context) (string, error)

    // Move a file (updates DB + search indices)
    MoveFile(ctx context.Context, from, to string) error

    // ──────────────────────────────────────────────────────────────
    // SUGGESTIONS (Agent-specific state)
    // ──────────────────────────────────────────────────────────────

    // Create a pending organization suggestion
    CreateSuggestion(ctx context.Context, s *Suggestion) (string, error)

    // Get pending suggestion for a conversation
    GetPendingSuggestion(ctx context.Context, convID string) (*Suggestion, error)

    // Execute/reject a suggestion
    ResolveSuggestion(ctx context.Context, suggestionID, action string) error
}

// SearchRequest matches the existing /api/search parameters
type SearchRequest struct {
    Query  string
    Type   string // mime type filter
    Folder string // path filter
    Limit  int
}

// FileWithDigests includes file + all digest content
type FileWithDigests struct {
    Path      string
    Name      string
    MimeType  string
    Size      int64
    CreatedAt time.Time
    Digests   map[string]DigestContent // key = digester name
}

// Suggestion is a pending organization action
type Suggestion struct {
    ID           string
    ConvID       string
    FilePath     string
    TargetFolder string
    Reasoning    string
    Confidence   float64
    Status       string
    CreatedAt    time.Time
}
```

---

## Implementation: LocalAppClient

For same-process deployment, directly call app services:

```go
// backend/agent/appclient/local.go

type LocalAppClient struct {
    db     *db.DB
    fs     *fs.Service
    search *search.Service
}

func NewLocalClient(db *db.DB, fs *fs.Service, search *search.Service) *LocalAppClient {
    return &LocalAppClient{db: db, fs: fs, search: search}
}

func (c *LocalAppClient) Search(ctx context.Context, req SearchRequest) (*SearchResult, error) {
    // Call search service directly
    return c.search.Search(ctx, search.Request{
        Query:  req.Query,
        Type:   req.Type,
        Path:   req.Folder,
        Limit:  req.Limit,
        Types:  []string{"keyword", "semantic"},
    })
}

func (c *LocalAppClient) GetFile(ctx context.Context, path string) (*FileWithDigests, error) {
    file, err := c.db.GetFile(ctx, path)
    if err != nil {
        return nil, err
    }

    digests, err := c.db.GetDigests(ctx, path)
    if err != nil {
        return nil, err
    }

    return &FileWithDigests{
        Path:      file.Path,
        Name:      file.Name,
        MimeType:  file.MimeType,
        Size:      file.Size,
        CreatedAt: file.CreatedAt,
        Digests:   digestsToMap(digests),
    }, nil
}

func (c *LocalAppClient) GetFolderTree(ctx context.Context, depth int) (*FolderNode, error) {
    return c.fs.GetFolderTree(depth)
}

func (c *LocalAppClient) ReadGuideline(ctx context.Context) (string, error) {
    content, err := c.fs.ReadFile("guideline.md")
    if err != nil {
        return "No guideline.md found", nil
    }
    return string(content), nil
}

func (c *LocalAppClient) MoveFile(ctx context.Context, from, to string) error {
    return c.fs.MoveFile(from, to)
}

// Suggestions stored in DB
func (c *LocalAppClient) CreateSuggestion(ctx context.Context, s *Suggestion) (string, error) {
    return c.db.CreateSuggestion(ctx, s)
}

func (c *LocalAppClient) GetPendingSuggestion(ctx context.Context, convID string) (*Suggestion, error) {
    return c.db.GetPendingSuggestion(ctx, convID)
}

func (c *LocalAppClient) ResolveSuggestion(ctx context.Context, id, action string) error {
    return c.db.ResolveSuggestion(ctx, id, action)
}
```

---

## The Agent

A simple conversation loop using Claude/GPT's native tool calling:

```go
// backend/agent/agent.go

type Agent struct {
    app       AppClient
    llm       LLMClient  // Anthropic or OpenAI client
    model     string
    convStore *ConversationStore
}

func NewAgent(app AppClient, llm LLMClient, model string) *Agent {
    return &Agent{
        app:       app,
        llm:       llm,
        model:     model,
        convStore: NewConversationStore(),
    }
}

func (a *Agent) Handle(ctx context.Context, req Request) (*Response, error) {
    // Load conversation history
    conv := a.convStore.Get(req.ConversationID)

    // Add user message
    conv.AddMessage(Message{Role: "user", Content: req.Text})

    // Build tool definitions from AppClient capabilities
    tools := a.buildTools()

    // System prompt includes user's guideline
    systemPrompt := a.buildSystemPrompt(ctx)

    // Agent loop - Claude decides what to do
    for turn := 0; turn < 10; turn++ {
        completion, err := a.llm.Complete(ctx, CompletionRequest{
            Model:    a.model,
            System:   systemPrompt,
            Messages: conv.Messages,
            Tools:    tools,
            MaxTokens: 4096,
        })
        if err != nil {
            return nil, err
        }

        // Check if agent wants to use tools
        if len(completion.ToolUse) == 0 {
            // No tools - final response
            conv.AddMessage(Message{
                Role:    "assistant",
                Content: completion.Content,
            })
            a.convStore.Save(conv)

            return &Response{
                ConversationID: req.ConversationID,
                Text:          completion.Content,
                Artifacts:     a.extractArtifacts(conv),
            }, nil
        }

        // Add assistant message with tool use
        conv.AddMessage(Message{
            Role:    "assistant",
            Content: completion.Content,
            ToolUse: completion.ToolUse,
        })

        // Execute each tool call via AppClient
        for _, tool := range completion.ToolUse {
            result, err := a.executeTool(ctx, tool)

            // Add tool result to conversation
            conv.AddMessage(Message{
                Role:         "user",
                ToolResultID: tool.ID,
                Content:      formatToolResult(result, err),
            })
        }

        // Continue loop - agent will see tool results and decide next step
    }

    return nil, fmt.Errorf("agent exceeded max turns")
}
```

---

## Tool Definitions

Tools map directly to AppClient methods:

```go
func (a *Agent) buildTools() []ToolDefinition {
    return []ToolDefinition{
        {
            Name:        "search",
            Description: "Search for files by content, name, tags, or description. Returns matching files with context.",
            InputSchema: map[string]any{
                "type": "object",
                "properties": map[string]any{
                    "query": map[string]any{
                        "type":        "string",
                        "description": "Search query - can be keywords or natural language",
                    },
                    "type": map[string]any{
                        "type":        "string",
                        "description": "Filter by mime type prefix (e.g., 'image/', 'application/pdf')",
                    },
                    "folder": map[string]any{
                        "type":        "string",
                        "description": "Limit search to specific folder",
                    },
                    "limit": map[string]any{
                        "type":        "integer",
                        "description": "Max results (default 10)",
                    },
                },
                "required": []string{"query"},
            },
        },
        {
            Name:        "get_file",
            Description: "Get detailed information about a file including extracted content from digests (OCR, transcription, etc.)",
            InputSchema: map[string]any{
                "type": "object",
                "properties": map[string]any{
                    "path": map[string]any{
                        "type":        "string",
                        "description": "File path",
                    },
                },
                "required": []string{"path"},
            },
        },
        {
            Name:        "get_folder_tree",
            Description: "Get the library folder structure to see available organization destinations",
            InputSchema: map[string]any{
                "type": "object",
                "properties": map[string]any{
                    "depth": map[string]any{
                        "type":        "integer",
                        "description": "How deep to traverse (default 2)",
                    },
                },
            },
        },
        {
            Name:        "read_guideline",
            Description: "Read the user's guideline.md file to understand their organization patterns and folder structure",
            InputSchema: map[string]any{
                "type":       "object",
                "properties": map[string]any{},
            },
        },
        {
            Name:        "create_suggestion",
            Description: "Create a pending suggestion to move a file to a folder. This requires user confirmation before executing.",
            InputSchema: map[string]any{
                "type": "object",
                "properties": map[string]any{
                    "file_path": map[string]any{
                        "type":        "string",
                        "description": "File to move",
                    },
                    "target_folder": map[string]any{
                        "type":        "string",
                        "description": "Destination folder",
                    },
                    "reasoning": map[string]any{
                        "type":        "string",
                        "description": "Brief explanation of why this is the right folder (1-2 sentences)",
                    },
                    "confidence": map[string]any{
                        "type":        "number",
                        "description": "Confidence score 0.0-1.0",
                    },
                },
                "required": []string{"file_path", "target_folder", "reasoning", "confidence"},
            },
        },
        {
            Name:        "list_recent_files",
            Description: "List recently added files for context",
            InputSchema: map[string]any{
                "type": "object",
                "properties": map[string]any{
                    "limit": map[string]any{
                        "type":        "integer",
                        "description": "Number of files (default 10)",
                    },
                    "type": map[string]any{
                        "type":        "string",
                        "description": "Filter by mime type prefix",
                    },
                },
            },
        },
    }
}
```

---

## Tool Execution

Map tool calls to AppClient methods:

```go
func (a *Agent) executeTool(ctx context.Context, tool ToolUse) (any, error) {
    switch tool.Name {
    case "search":
        var params struct {
            Query  string `json:"query"`
            Type   string `json:"type"`
            Folder string `json:"folder"`
            Limit  int    `json:"limit"`
        }
        json.Unmarshal(tool.Input, &params)

        if params.Limit == 0 {
            params.Limit = 10
        }

        return a.app.Search(ctx, SearchRequest{
            Query:  params.Query,
            Type:   params.Type,
            Folder: params.Folder,
            Limit:  params.Limit,
        })

    case "get_file":
        var params struct {
            Path string `json:"path"`
        }
        json.Unmarshal(tool.Input, &params)
        return a.app.GetFile(ctx, params.Path)

    case "get_folder_tree":
        var params struct {
            Depth int `json:"depth"`
        }
        json.Unmarshal(tool.Input, &params)
        if params.Depth == 0 {
            params.Depth = 2
        }
        return a.app.GetFolderTree(ctx, params.Depth)

    case "read_guideline":
        return a.app.ReadGuideline(ctx)

    case "create_suggestion":
        var params struct {
            FilePath     string  `json:"file_path"`
            TargetFolder string  `json:"target_folder"`
            Reasoning    string  `json:"reasoning"`
            Confidence   float64 `json:"confidence"`
        }
        json.Unmarshal(tool.Input, &params)

        return a.app.CreateSuggestion(ctx, &Suggestion{
            ConvID:       a.currentConvID,
            FilePath:     params.FilePath,
            TargetFolder: params.TargetFolder,
            Reasoning:    params.Reasoning,
            Confidence:   params.Confidence,
        })

    case "list_recent_files":
        var params struct {
            Limit int    `json:"limit"`
            Type  string `json:"type"`
        }
        json.Unmarshal(tool.Input, &params)
        if params.Limit == 0 {
            params.Limit = 10
        }
        return a.app.ListRecentFiles(ctx, params.Limit, params.Type)

    default:
        return nil, fmt.Errorf("unknown tool: %s", tool.Name)
    }
}
```

---

## System Prompt

The system prompt gives the agent its personality and context:

```
You are a helpful personal assistant for MyLifeDB, a personal knowledge management system.

## Your Role

You help users:
1. **Find information** - Search through files, answer questions about their data
2. **Organize files** - Suggest moving files to appropriate folders based on their organization patterns
3. **Understand content** - Read and summarize file contents (OCR, transcriptions, digests)

## User's Organization Patterns

{guideline_content}

## Available Tools

You have access to these tools:
- search: Find files by content, name, or description
- get_file: Get detailed file content and metadata
- get_folder_tree: See the user's folder structure
- read_guideline: Read the user's organization guide
- list_recent_files: See recently added files
- create_suggestion: Suggest moving a file (requires user confirmation)

## Guidelines

### When searching:
- Use semantic understanding - "ID photo" should match "license", "passport", etc.
- If search returns too many results, ask clarifying questions
- Show relevant files to the user with context

### When organizing files:
1. **Always read guideline.md first** to understand the user's patterns
2. Check the folder tree to see available destinations
3. Examine the file content and metadata
4. Suggest the most appropriate folder with clear reasoning
5. Provide confidence score (0.0-1.0)
6. Offer alternatives if multiple folders could fit

**Important**: Never move files without calling create_suggestion first. The user must confirm.

### Confidence levels:
- High (>0.9): Strong match to existing patterns
- Medium (0.7-0.9): Good match but some uncertainty
- Low (<0.7): Ask user for guidance

## Conversation Style

- Be conversational and helpful
- Explain your reasoning clearly
- Ask questions when unclear
- Admit when you're not sure

## Context

Recent files in inbox:
{recent_inbox_files}
```

```go
func (a *Agent) buildSystemPrompt(ctx context.Context) string {
    // Read user's guideline
    guideline, _ := a.app.ReadGuideline(ctx)

    // Get recent inbox files for context
    recentFiles, _ := a.app.ListRecentFiles(ctx, 5, "")

    return fmt.Sprintf(systemPromptTemplate, guideline, formatRecentFiles(recentFiles))
}
```

---

## Example Flows

### User Query: "find my ID photo"

```
User message: "find my ID photo"
        ↓
Agent thinks: "User wants to find an ID photo. I'll search for it."
        ↓
Agent calls: search(query="ID license passport photo", type="image/")
        ↓
Search returns:
  - life/gov docs/ID.jpg (score: 0.95)
  - life/gov docs/license.png (score: 0.89)
  - documents/passport.jpg (score: 0.82)
        ↓
Agent responds: "I found 3 photos that might be your ID:
                 1. ID.jpg in life/gov docs/
                 2. license.png in life/gov docs/
                 3. passport.jpg in documents/

                 Would you like me to show you any of these?"
```

### Auto-Organization: New file digest completed

```
File: inbox/W2_2024.pdf
Digest completed → trigger organization
        ↓
Agent initialized with context:
  - Recent inbox files
  - Pending suggestions (none)
        ↓
Agent calls: read_guideline()
        ↓
Guideline shows:
  - work/hotstar/compensation/ for salary/equity docs
  - life/gov docs/ for government forms
        ↓
Agent calls: get_file("inbox/W2_2024.pdf")
        ↓
File content shows:
  - Form W-2 (tax document)
  - Employer: Hotstar
  - Year: 2024
        ↓
Agent calls: get_folder_tree(2)
        ↓
Folder tree confirms:
  - work/hotstar/compensation/ exists
        ↓
Agent calls: create_suggestion(
    file_path="inbox/W2_2024.pdf",
    target_folder="work/hotstar/compensation/",
    reasoning="W-2 is a tax form from your employer Hotstar. Based on your guideline, compensation-related documents go in work/hotstar/compensation/",
    confidence=0.92
)
        ↓
User sees notification:
  "I suggest moving W2_2024.pdf to work/hotstar/compensation/
   [Move] [Keep in Inbox] [Choose Different Folder]"
```

---

## Database Schema

### Conversations

```sql
CREATE TABLE inbox_conversations (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'active', -- active, completed, archived
    summary TEXT -- brief summary of conversation
);
```

### Messages

```sql
CREATE TABLE inbox_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL, -- user, assistant
    content TEXT NOT NULL,
    metadata TEXT, -- JSON for tool_use, attachments, etc.
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES inbox_conversations(id)
);
```

### Suggestions

```sql
CREATE TABLE organization_suggestions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    target_folder TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT DEFAULT 'pending', -- pending, accepted, rejected, expired
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES inbox_conversations(id)
);
```

---

## API Endpoints

### Send message

```
POST /api/inbox/agent/message
{
  "message": "find my ID photo",
  "conversation_id": "optional-existing-conversation"
}

Response:
{
  "conversation_id": "conv-123",
  "message": {
    "id": "msg-456",
    "role": "assistant",
    "content": "I found 3 photos...",
    "artifacts": [
      {"type": "file", "path": "life/gov docs/ID.jpg"},
      {"type": "file", "path": "life/gov docs/license.png"}
    ]
  }
}
```

### Get conversation

```
GET /api/inbox/agent/conversations/:id

Response:
{
  "id": "conv-123",
  "created_at": "2025-02-05T10:00:00Z",
  "updated_at": "2025-02-05T10:05:00Z",
  "status": "active",
  "messages": [
    {
      "id": "msg-1",
      "role": "user",
      "content": "find my ID photo",
      "created_at": "2025-02-05T10:00:00Z"
    },
    {
      "id": "msg-2",
      "role": "assistant",
      "content": "I found 3 photos...",
      "artifacts": [...],
      "created_at": "2025-02-05T10:00:05Z"
    }
  ],
  "pending_suggestion": {
    "id": "sug-789",
    "file_path": "inbox/W2_2024.pdf",
    "target_folder": "work/hotstar/compensation/",
    "reasoning": "...",
    "confidence": 0.92
  }
}
```

### List conversations

```
GET /api/inbox/agent/conversations
  ?status=active,completed,archived
  &limit=20

Response:
{
  "conversations": [
    {
      "id": "conv-123",
      "created_at": "2025-02-05T10:00:00Z",
      "updated_at": "2025-02-05T10:05:00Z",
      "status": "active",
      "summary": "Finding ID photos and organizing W-2 form",
      "last_message": "I found 3 photos that might be your ID...",
      "unread_count": 2
    }
  ]
}
```

### Handle suggestion

```
POST /api/inbox/agent/suggestions/:id/resolve
{
  "action": "accept" // or "reject"
}

Response:
{
  "success": true,
  "file_moved": true, // only for accept action
  "new_path": "work/hotstar/compensation/W2_2024.pdf"
}
```

---

## Auto-Organization Trigger

Hook into the digest worker completion event:

```go
// backend/server/server.go

func (s *Server) wireEventHandlers() {
    // ... existing handlers ...

    // Trigger agent organization when digest completes for inbox files
    s.digestWorker.SetCompletionHandler(func(filePath string) {
        if strings.HasPrefix(filePath, "inbox/") {
            go s.triggerAutoOrganization(filePath)
        }
    })
}

func (s *Server) triggerAutoOrganization(filePath string) {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Create or get conversation for auto-organization
    convID := "auto-org-" + time.Now().Format("2006-01-02")
    conv := s.agentConvStore.GetOrCreate(convID)

    // Build message asking agent to organize this file
    msg := fmt.Sprintf("A new file has been added to inbox: %s. Please analyze it and suggest where it should be organized.", filePath)

    // Send to agent
    resp, err := s.agent.Handle(ctx, agent.Request{
        ConversationID: convID,
        Text:          msg,
    })

    if err != nil {
        log.Error().Err(err).Str("file", filePath).Msg("auto-organization failed")
        return
    }

    // If agent created a suggestion, notify user via SSE
    if resp.Suggestion != nil {
        s.notifService.NotifyOrganizationSuggestion(resp.Suggestion)
    }
}
```

---

## Server Integration

Add agent components to the Server struct:

```go
// backend/server/server.go

type Server struct {
    // ... existing fields ...

    agent          *agent.Agent
    agentConvStore *agent.ConversationStore
    appClient      appclient.AppClient
}

func New(cfg *Config) (*Server, error) {
    // ... existing initialization ...

    // Create AppClient interface
    s.appClient = appclient.NewLocalClient(s.database, s.fsService, s.searchService)

    // Create LLM client
    llmClient := vendors.NewOpenAIClient(cfg.OpenAIConfig)

    // Create agent
    s.agent = agent.NewAgent(s.appClient, llmClient, cfg.AgentModel)
    s.agentConvStore = agent.NewConversationStore()

    // Wire event handlers (including auto-organization trigger)
    s.wireEventHandlers()

    return s, nil
}

// Expose for API handlers
func (s *Server) Agent() *agent.Agent { return s.agent }
func (s *Server) AgentConversations() *agent.ConversationStore { return s.agentConvStore }
```

---

## Configuration

Add agent settings to config:

```go
// backend/config/config.go

type AgentConfig struct {
    Enabled   bool   `env:"AGENT_ENABLED" default:"true"`
    Model     string `env:"AGENT_MODEL" default:"claude-3-5-sonnet-20250219"`
    MaxTokens int    `env:"AGENT_MAX_TOKENS" default:"4096"`
    MaxTurns  int    `env:"AGENT_MAX_TURNS" default:"10"`

    // Auto-organization
    AutoOrganize bool    `env:"AGENT_AUTO_ORGANIZE" default:"true"`
    MinConfidence float64 `env:"AGENT_MIN_CONFIDENCE" default:"0.7"`
}
```

---

## Implementation Phases

### Phase 1: Foundation (1-2 days)
- [ ] Database migrations (conversations, messages, suggestions)
- [ ] AppClient interface definition
- [ ] LocalAppClient implementation
- [ ] Basic agent structure with conversation loop
- [ ] Tool definitions and execution

### Phase 2: Core Tools (2-3 days)
- [ ] Search tool (reuse existing search service)
- [ ] GetFile tool (with digest content)
- [ ] GetFolderTree tool
- [ ] ReadGuideline tool
- [ ] ListRecentFiles tool
- [ ] CreateSuggestion tool

### Phase 3: API & Frontend (2-3 days)
- [ ] API endpoints (message, conversations, suggestions)
- [ ] Frontend inbox UI with message feed
- [ ] Message input component
- [ ] File artifact display
- [ ] Suggestion UI with accept/reject buttons

### Phase 4: Auto-Organization (1-2 days)
- [ ] Hook digest completion event
- [ ] Auto-trigger agent for inbox files
- [ ] SSE notifications for suggestions
- [ ] Settings for auto-organization preferences

### Phase 5: Polish (1-2 days)
- [ ] Streaming responses (SSE)
- [ ] Conversation management (archive, delete)
- [ ] Error handling and retries
- [ ] Loading states and optimistic updates
- [ ] Testing and bug fixes

**Total estimate: 7-12 days**

---

## Future Enhancements

### Multi-turn Conversations
- Keep context across multiple messages
- Support follow-up questions
- Conversation summarization for long threads

### Learning from Decisions
- Track accepted/rejected suggestions
- Adjust confidence scores based on patterns
- Suggest updates to guideline.md

### Bulk Operations
- "Organize all inbox files"
- "Find all untagged photos"
- Batch suggestion review

### Advanced Tools
- `tag_file` - Add tags to files
- `summarize_file` - Generate summaries
- `find_similar` - Find related files
- `extract_entities` - Find people, dates, locations

### RemoteAppClient
For service deployment:

```go
// backend/agent/appclient/remote.go

type RemoteAppClient struct {
    baseURL string
    client  *http.Client
}

func (c *RemoteAppClient) Search(ctx context.Context, req SearchRequest) (*SearchResult, error) {
    // HTTP call to app API
    return httpPost[SearchResult](c.client, c.baseURL+"/api/search", req)
}

// ... other methods via HTTP
```

---

## Comparison with Previous Design

### What Changed

| Aspect | inbox-agent.md | inbox-agent-v2.md (This Doc) |
|--------|----------------|------------------------------|
| **Agent Architecture** | Two-stage with router + specialized agents | Single general-purpose agent |
| **Skill System** | Custom skill abstraction | Native Claude tool use |
| **Intent Classification** | Fast router (gpt-4o-mini) | Agent decides via tools |
| **Separation** | Embedded in app | Independent via AppClient |
| **Complexity** | Higher (router, registry, multiple agents) | Lower (one agent, simple tools) |
| **Extensibility** | Add new agents | Add new tools |

### Why Simpler?

1. **One agent** can handle both query and organize tasks
2. **Claude's tool use** is powerful enough - no need for router
3. **AppClient interface** provides clean separation
4. **Fewer moving parts** = easier to maintain
5. **Still extensible** - just add new tools as needed

### When to Revisit Router Pattern

Consider the two-stage architecture if:
- Latency becomes a problem (>2s for simple queries)
- Cost becomes significant (too many tool calls)
- Need domain-specific expertise (different system prompts per task)
- Multiple specialized workflows emerge

For now, **keep it simple** with one intelligent agent.

---

## Related Documents

- [inbox-agent.md](inbox-agent.md) - Original two-stage design (archived)
- [inbox-agent-tech-design.md](inbox-agent-tech-design.md) - Technical details for two-stage approach
- [architecture.md](../architecture.md) - Overall system architecture
- [digest-system.md](digest-system.md) - File processing pipeline
- [fs-service.md](fs-service.md) - Filesystem operations
- [claude-code.md](claude-code.md) - Reference for conversation UI patterns

---

*Created: 2025-02-05*
*Last updated: 2025-02-05*