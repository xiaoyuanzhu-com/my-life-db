# Inbox Agent Architecture

This document describes the architecture for two conversational AI features in the inbox:

1. **Auto-Organization** - Automatically suggest organizing inbox files into library folders
2. **Conversational Queries** - Natural language queries like "find my ID license photo"

---

## Design Philosophy

The inbox becomes a **conversational interface** where:
- Users send data (files, text, URLs) as they do today
- Users can also ask questions or give commands naturally
- The system responds intelligently - sometimes with files, sometimes with answers, sometimes with suggestions
- Everything feels like chatting with a helpful assistant

**Key Principle:** The agent should feel like a person, not a command-line tool. It decides what kind of response is appropriate.

---

## Multi-Stage Architecture

The system uses a **two-stage architecture** optimized for both speed and quality:

### Stage 1: Fast Router (Intent Classification)
- **Model**: Small, fast model (e.g., `gpt-4o-mini`, local model, or fine-tuned classifier)
- **Latency**: ~100-200ms
- **Purpose**: Quickly classify user intent and route to appropriate agent
- **No tools**: Pure classification, no external calls

### Stage 2: Specialized Agents
- **Model**: Heavier, more capable model (e.g., `gpt-4o`, `claude-3-5-sonnet`)
- **Latency**: Variable (500ms - 5s depending on complexity)
- **Purpose**: Execute the actual task with tools and context
- **Tools**: Each agent has access to specific tools for its domain

```
┌─────────────────────────────────────────────────────────────────────┐
│                         INBOX FEED (UI)                             │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ User Input (text/file/URL) ──────────────────────────────────┼───┤
│  │                                                              │   │
│  │ ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │   │
│  │ │ User Message│  │ Agent Reply │  │ File Card   │           │   │
│  │ │ "find my    │  │ "Found 3    │  │ [ID.jpg]    │           │   │
│  │ │  ID photo"  │  │  matches:"  │  │             │           │   │
│  │ └─────────────┘  └─────────────┘  └─────────────┘           │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     STAGE 1: FAST ROUTER                            │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Intent Classifier                           │ │
│  │            (gpt-4o-mini / local model / fine-tuned)           │ │
│  │                        ~100-200ms                              │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                      │
│              ┌───────────────┼───────────────┐                      │
│              ▼               ▼               ▼                      │
│         ┌────────┐     ┌────────┐     ┌────────┐                   │
│         │ QUERY  │     │ORGANIZE│     │  SAVE  │                   │
│         │        │     │        │     │ (none) │                   │
│         └────────┘     └────────┘     └────────┘                   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   STAGE 2: SPECIALIZED AGENTS                       │
│                                                                     │
│  ┌─────────────────────┐        ┌─────────────────────┐            │
│  │    QUERY AGENT      │        │   ORGANIZE AGENT    │            │
│  │  (gpt-4o / claude)  │        │  (gpt-4o / claude)  │            │
│  │                     │        │                     │            │
│  │  Tools:             │        │  Tools:             │            │
│  │  - search_files     │        │  - get_folder_tree  │            │
│  │  - get_file_content │        │  - read_guideline   │            │
│  │  - summarize        │        │  - suggest_folder   │            │
│  │  - answer_question  │        │  - move_file        │            │
│  └─────────────────────┘        └─────────────────────┘            │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    EXISTING SERVICES                          │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │  │
│  │  │ Search  │ │ Digest  │ │   FS    │ │ OpenAI  │            │  │
│  │  │ (Meili/ │ │ Worker  │ │ Service │ │ Vendor  │            │  │
│  │  │ Qdrant) │ │         │ │         │ │         │            │  │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘            │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Why Two Stages?

| Concern | Single-Stage | Two-Stage |
|---------|--------------|-----------|
| **Latency** | Always slow (~2-5s) | Fast for simple intents (~200ms routing + agent time) |
| **Cost** | Always expensive | Cheap routing + expensive only when needed |
| **Accuracy** | One model does everything | Specialized agents do better at their domain |
| **Extensibility** | Monolithic | Easy to add new agents |
| **Failure isolation** | One failure affects all | Agents fail independently |

### Stage 1: Intent Router Details

The router is a simple classifier that outputs:
1. **Intent type** (query, organize, save, confirm, reject, chat)
2. **Confidence score** (0.0-1.0)
3. **Extracted parameters** (optional, for simple cases)

```go
type RouterOutput struct {
    Intent     IntentType  `json:"intent"`
    Confidence float64     `json:"confidence"`
    Params     RouterParams `json:"params,omitempty"`
}

type IntentType string
const (
    IntentQuery    IntentType = "query"     // User wants to find/ask about something
    IntentOrganize IntentType = "organize"  // User wants to organize files
    IntentSave     IntentType = "save"      // User is saving new data (file/text/URL)
    IntentConfirm  IntentType = "confirm"   // User confirms a pending action
    IntentReject   IntentType = "reject"    // User rejects a pending action
    IntentChat     IntentType = "chat"      // General conversation (greeting, thanks, etc.)
)

type RouterParams struct {
    // For IntentQuery
    SearchQuery string `json:"search_query,omitempty"`

    // For IntentOrganize
    FilePath    string `json:"file_path,omitempty"`
    TargetHint  string `json:"target_hint,omitempty"` // e.g., "work folder"

    // For IntentConfirm/Reject
    ActionID    string `json:"action_id,omitempty"`
}
```

**Router Prompt Example:**
```
You are an intent classifier for a personal file management system.
Given a user message and conversation context, classify the intent.

Intents:
- query: User wants to find files, ask questions about their data, get summaries
- organize: User wants to move/organize files into folders
- save: User is adding new data (no question, just content to store)
- confirm: User is saying yes/ok/do it to a pending suggestion
- reject: User is saying no/cancel/keep it to a pending suggestion
- chat: Greeting, thanks, or unclear intent

Recent context:
{conversation_history}

Pending action: {pending_suggestion_or_none}

User message: {user_message}

Output JSON: {"intent": "...", "confidence": 0.0-1.0, "params": {...}}
```

### Stage 2: Specialized Agents

Each agent is a focused LLM with domain-specific tools and system prompts.

#### Query Agent
**Purpose**: Find files, answer questions about user's data, provide summaries

**Tools available**:
- `search_files(query, filters)` - Keyword + semantic search
- `get_file_content(path)` - Read file digest/content
- `get_file_metadata(path)` - Get file info (size, date, type)
- `list_recent_files(limit, type)` - List recently added files
- `respond_to_user(message, attachments)` - Send response with optional file references

**System prompt excerpt**:
```
You are a helpful assistant for a personal file database.
You help users find files and answer questions about their data.

You have access to:
- Full-text and semantic search across all files
- File metadata and extracted content (OCR, transcriptions, etc.)
- User's folder structure and organization patterns

When responding:
- Be conversational and helpful
- Show relevant files when found
- Ask clarifying questions if the query is ambiguous
- Summarize content when asked
```

#### Organize Agent
**Purpose**: Suggest and execute file organization

**Tools available**:
- `get_folder_tree(depth)` - Get library folder structure
- `read_guideline()` - Read user's guideline.md for patterns
- `get_file_info(path)` - Get file details and digest content
- `suggest_organization(file, folder, reasoning)` - Propose a move
- `execute_move(file, target)` - Actually move the file
- `respond_to_user(message)` - Send response

**System prompt excerpt**:
```
You are an organization assistant for a personal file database.
You help users organize their inbox files into the appropriate library folders.

You have access to:
- The user's folder structure and naming conventions
- Their organization guidelines (guideline.md)
- File content and metadata

When suggesting organization:
- Always read guideline.md first to understand the user's patterns
- Explain your reasoning clearly
- Offer alternatives if multiple folders could fit
- Never move files without explicit confirmation (unless confidence > 95%)
```

---

## Data Model

### New Tables

```sql
-- Conversation threads in inbox
inbox_conversations (
    id              TEXT PRIMARY KEY,     -- UUID
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL,
    status          TEXT NOT NULL,        -- 'active', 'completed', 'archived'
    summary         TEXT                  -- AI-generated conversation summary
)

-- Messages in conversations (both user and agent)
inbox_messages (
    id              TEXT PRIMARY KEY,     -- UUID
    conversation_id TEXT NOT NULL,        -- FK to inbox_conversations
    role            TEXT NOT NULL,        -- 'user', 'agent', 'system'
    type            TEXT NOT NULL,        -- 'text', 'file', 'suggestion', 'search_result', etc.
    content         TEXT NOT NULL,        -- JSON content (structure depends on type)
    metadata        TEXT,                 -- JSON metadata (tokens used, model, timing, etc.)
    created_at      DATETIME NOT NULL,

    FOREIGN KEY (conversation_id) REFERENCES inbox_conversations(id)
)

-- Pending organization suggestions (requires user action)
organization_suggestions (
    id              TEXT PRIMARY KEY,     -- UUID
    message_id      TEXT NOT NULL,        -- FK to inbox_messages
    file_path       TEXT NOT NULL,        -- File to move
    target_folder   TEXT NOT NULL,        -- Suggested destination
    reasoning       TEXT NOT NULL,        -- Why this suggestion
    confidence      REAL NOT NULL,        -- 0.0-1.0 confidence score
    status          TEXT NOT NULL,        -- 'pending', 'accepted', 'rejected', 'expired'
    created_at      DATETIME NOT NULL,
    resolved_at     DATETIME,

    FOREIGN KEY (message_id) REFERENCES inbox_messages(id)
)

-- Index for efficient queries
CREATE INDEX idx_inbox_messages_conversation ON inbox_messages(conversation_id, created_at);
CREATE INDEX idx_organization_suggestions_status ON organization_suggestions(status, created_at);
CREATE INDEX idx_organization_suggestions_file ON organization_suggestions(file_path);
```

### Message Content Types

```typescript
// Message content is JSON, structure depends on type

// type: 'text'
{ text: string }

// type: 'file' (existing inbox item reference)
{ path: string }

// type: 'search_result'
{
  query: string,
  results: Array<{
    path: string,
    relevance: number,
    matchContext: string
  }>,
  totalFound: number
}

// type: 'suggestion' (organization suggestion)
{
  suggestionId: string,
  filePath: string,
  fileName: string,
  targetFolder: string,
  reasoning: string,
  confidence: number,
  alternatives?: Array<{ folder: string, reasoning: string }>
}

// type: 'action_result'
{
  action: 'move' | 'rename' | 'delete',
  success: boolean,
  details: string
}

// type: 'summary'
{ text: string, sources: string[] }

// type: 'clarification'
{
  question: string,
  options?: string[]
}
```

---

## Stage 1: Intent Router (Fast Classification)

The router is the first stage that quickly classifies user intent before spinning up a heavier agent.

### Intent Categories

| Intent | Examples | Routes To |
|--------|----------|-----------|
| `query` | "find my ID photo", "what's in that PDF", "how many photos do I have" | Query Agent |
| `organize` | "put this in my work folder", "organize my inbox" | Organize Agent |
| `save` | [file/URL/text with no question] | Direct save (no agent) |
| `confirm` | "yes", "do it", "sounds good" | Execute pending action |
| `reject` | "no", "keep it here", "cancel" | Cancel pending action |
| `chat` | "thanks", "hello" | Simple response (no agent) |

### Router Implementation

```go
// backend/agent/router/router.go

type Router struct {
    fastModel   string  // e.g., "gpt-4o-mini"
    openai      *vendors.OpenAIClient
}

type RouterInput struct {
    Message       string
    Context       *ConversationContext  // Recent messages
    PendingAction *PendingSuggestion    // If awaiting user response
}

type RouterOutput struct {
    Intent     IntentType
    Confidence float64
    Params     map[string]string  // Extracted parameters
    Reasoning  string             // For debugging
}

func (r *Router) Classify(ctx context.Context, input RouterInput) (*RouterOutput, error) {
    // 1. Fast-path: Check for pending action responses
    if input.PendingAction != nil {
        if isAffirmative(input.Message) {
            return &RouterOutput{Intent: IntentConfirm, Confidence: 0.95}, nil
        }
        if isNegative(input.Message) {
            return &RouterOutput{Intent: IntentReject, Confidence: 0.95}, nil
        }
    }

    // 2. Fast-path: Pure data (file upload, URL, long text without question marks)
    if isPureData(input.Message) {
        return &RouterOutput{Intent: IntentSave, Confidence: 0.9}, nil
    }

    // 3. LLM classification for everything else
    return r.llmClassify(ctx, input)
}

func (r *Router) llmClassify(ctx context.Context, input RouterInput) (*RouterOutput, error) {
    prompt := buildRouterPrompt(input)

    response, err := r.openai.Complete(ctx, OpenAICompletionRequest{
        Model:       r.fastModel,
        Messages:    []OpenAIMessage{{Role: "user", Content: prompt}},
        Temperature: 0.0,  // Deterministic
        MaxTokens:   100,  // Very short response
        ResponseFormat: &ResponseFormat{Type: "json_object"},
    })

    return parseRouterResponse(response)
}
```

### Router Prompt

```
You are an intent classifier for a personal knowledge management system.

## Intents
- query: User wants to FIND files, ASK questions, GET information, or SUMMARIZE content
- organize: User wants to MOVE, ORGANIZE, or SORT files into folders
- save: User is ADDING new data without asking anything (just text, URL, or file)
- confirm: User is saying YES to a pending suggestion (only if pending_action exists)
- reject: User is saying NO to a pending suggestion (only if pending_action exists)
- chat: Greetings, thanks, or completely unclear intent

## Context
Recent conversation:
{last_3_messages}

Pending action: {pending_action_or_none}

## User Message
"{user_message}"

## Output
Respond with JSON only:
{"intent": "query|organize|save|confirm|reject|chat", "confidence": 0.0-1.0, "params": {}}

For "query" intent, extract search_query if clear.
For "organize" intent, extract target_folder if mentioned.
```

### Latency Optimization

The router is optimized for speed:

| Optimization | Impact |
|--------------|--------|
| Small model (gpt-4o-mini) | ~2-3x faster than gpt-4o |
| Low max_tokens (100) | Faster generation |
| Temperature 0 | Single-pass, no sampling |
| JSON mode | Structured output, no parsing errors |
| Fast-path rules | Skip LLM for obvious cases |
| Connection pooling | Reuse HTTP connections |

**Target latency**: <200ms for classification

---

## Stage 2: Specialized Agents

After classification, the appropriate agent is spawned to handle the request.

### Agent Interface

```go
// backend/agent/agent.go

type Agent interface {
    Name() string
    Handle(ctx context.Context, request AgentRequest) (*AgentResponse, error)
}

type AgentRequest struct {
    Message      string
    Intent       IntentType
    Params       map[string]string
    Conversation *ConversationContext
    User         *UserContext
}

type AgentResponse struct {
    Messages []ResponseMessage  // Can be multiple (e.g., text + file cards)
    Actions  []Action           // Side effects (file moves, etc.)
    State    map[string]any     // State to persist (for multi-turn)
}

type ResponseMessage struct {
    Type    string      // "text", "search_result", "suggestion", etc.
    Content interface{} // Type-specific content
}
```

### Agent Registry

```go
// backend/agent/registry.go

type AgentRegistry struct {
    agents map[IntentType]Agent
}

func NewAgentRegistry(cfg AgentConfig) *AgentRegistry {
    return &AgentRegistry{
        agents: map[IntentType]Agent{
            IntentQuery:    NewQueryAgent(cfg),
            IntentOrganize: NewOrganizeAgent(cfg),
            // IntentSave doesn't need an agent - handled directly
            // IntentConfirm/Reject handled by action executor
            // IntentChat handled by simple responder
        },
    }
}

func (r *AgentRegistry) GetAgent(intent IntentType) (Agent, bool) {
    agent, ok := r.agents[intent]
    return agent, ok
}
```

---

## Query Agent

Handles all information retrieval: finding files, answering questions, summarizing content.

### Tools

```go
// backend/agent/query/tools.go

// Search across all files using keyword + semantic search
type SearchFilesTool struct {
    search *SearchService
}

func (t *SearchFilesTool) Schema() ToolSchema {
    return ToolSchema{
        Name: "search_files",
        Description: "Search for files by content, name, or description",
        Parameters: map[string]ParameterSchema{
            "query": {Type: "string", Required: true, Description: "Search query"},
            "type":  {Type: "string", Description: "Filter by mime type (e.g., 'image/', 'application/pdf')"},
            "folder": {Type: "string", Description: "Limit search to folder"},
            "limit": {Type: "integer", Description: "Max results (default 10)"},
        },
    }
}

// Get detailed content/digest of a specific file
type GetFileContentTool struct {
    db *db.DB
}

func (t *GetFileContentTool) Schema() ToolSchema {
    return ToolSchema{
        Name: "get_file_content",
        Description: "Get the extracted content and metadata of a file",
        Parameters: map[string]ParameterSchema{
            "path": {Type: "string", Required: true, Description: "File path"},
        },
    }
}

// List recently added/modified files
type ListRecentFilesTool struct {
    db *db.DB
}

// Get statistics about user's files
type GetStatsTool struct {
    db *db.DB
}

// Final response to user
type RespondTool struct{}

func (t *RespondTool) Schema() ToolSchema {
    return ToolSchema{
        Name: "respond_to_user",
        Description: "Send a response to the user. Call this when you have the answer.",
        Parameters: map[string]ParameterSchema{
            "message": {Type: "string", Required: true, Description: "Response text"},
            "files":   {Type: "array", Description: "File paths to show as cards"},
        },
    }
}
```

### Query Agent System Prompt

```
You are a helpful assistant for a personal file database called MyLifeDB.
You help users find files and answer questions about their data.

## Your Capabilities
- Search files by content, name, tags, or description
- Read and summarize file contents
- Answer questions about the user's data
- Provide statistics and insights

## Guidelines
- Be conversational and helpful
- When you find relevant files, show them to the user
- If a search returns too many results, ask clarifying questions
- If no results found, suggest alternative search terms
- Summarize long content when appropriate

## Available Tools
{tool_descriptions}

## User's Recent Files (for context)
{recent_files_summary}

Always end by calling respond_to_user with your final answer.
```

### Query Agent Flow

```
User: "find my ID photo"
           │
           ▼
┌─────────────────────────────┐
│   Query Agent Initialized   │
│   Model: gpt-4o             │
│   Tools: search, content,   │
│          stats, respond     │
└─────────────────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ Agent thinks:               │
│ "User wants an ID photo.    │
│  I'll search for it."       │
│                             │
│ → calls search_files(       │
│     query="ID license       │
│            photo passport", │
│     type="image/"           │
│   )                         │
└─────────────────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ Search returns 3 results:   │
│ - life/gov docs/ID.jpg      │
│ - life/gov docs/license.png │
│ - documents/passport.jpg    │
└─────────────────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ Agent thinks:               │
│ "Found 3 potential matches. │
│  Let me respond."           │
│                             │
│ → calls respond_to_user(    │
│     message="I found 3      │
│       photos that might     │
│       be your ID:",         │
│     files=[...]             │
│   )                         │
└─────────────────────────────┘
           │
           ▼
      Response sent
```

---

## Organize Agent

Handles file organization: suggesting folders, moving files, understanding user's patterns.

### Tools

```go
// backend/agent/organize/tools.go

// Get the folder structure
type GetFolderTreeTool struct {
    fs *fs.Service
}

func (t *GetFolderTreeTool) Schema() ToolSchema {
    return ToolSchema{
        Name: "get_folder_tree",
        Description: "Get the library folder structure",
        Parameters: map[string]ParameterSchema{
            "depth": {Type: "integer", Description: "How deep to traverse (default 2)"},
        },
    }
}

// Read the user's organization guidelines
type ReadGuidelineTool struct {
    fs *fs.Service
}

func (t *ReadGuidelineTool) Schema() ToolSchema {
    return ToolSchema{
        Name: "read_guideline",
        Description: "Read the user's guideline.md file for organization patterns",
        Parameters: map[string]ParameterSchema{},
    }
}

// Get file info for organization decision
type GetFileInfoTool struct {
    db *db.DB
}

// Propose an organization (creates pending suggestion)
type SuggestOrganizationTool struct {
    db *db.DB
}

func (t *SuggestOrganizationTool) Schema() ToolSchema {
    return ToolSchema{
        Name: "suggest_organization",
        Description: "Suggest moving a file to a folder. Creates a pending suggestion for user to confirm.",
        Parameters: map[string]ParameterSchema{
            "file":       {Type: "string", Required: true, Description: "File path to move"},
            "target":     {Type: "string", Required: true, Description: "Target folder path"},
            "reasoning":  {Type: "string", Required: true, Description: "Why this folder is appropriate"},
            "confidence": {Type: "number", Required: true, Description: "Confidence 0.0-1.0"},
            "alternatives": {Type: "array", Description: "Other possible folders"},
        },
    }
}

// Execute a move (after confirmation)
type MoveFileTool struct {
    fs *fs.Service
    db *db.DB
}

// Respond to user
type RespondTool struct{}
```

### Organize Agent System Prompt

```
You are an organization assistant for a personal file database called MyLifeDB.
You help users organize their inbox files into the appropriate library folders.

## Your Workflow
1. ALWAYS read guideline.md first to understand the user's organization patterns
2. Get the folder tree to see available destinations
3. Analyze the file content and metadata
4. Suggest the most appropriate folder with clear reasoning

## Guidelines
- Respect the user's existing patterns (from guideline.md)
- Explain your reasoning clearly
- Offer alternatives if multiple folders could fit
- Ask for clarification if you're unsure
- Never move files without calling suggest_organization first
- High confidence (>0.9): Can proceed with minimal explanation
- Medium confidence (0.7-0.9): Explain reasoning and offer alternatives
- Low confidence (<0.7): Ask user for guidance

## Available Tools
{tool_descriptions}

## Important
- Always read guideline.md before making suggestions
- Use the folder tree to propose valid destinations
- Your reasoning should reference patterns from guideline.md when possible
```

### Organize Agent Flow

```
User: "organize this" (pointing to inbox/W2_2024.pdf)
           │
           ▼
┌─────────────────────────────┐
│  Organize Agent Initialized │
│  Model: gpt-4o              │
│  Tools: folder_tree,        │
│         guideline, file,    │
│         suggest, move       │
└─────────────────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ Agent thinks:               │
│ "First, let me understand   │
│  the user's patterns."      │
│                             │
│ → calls read_guideline()    │
└─────────────────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ Guideline shows:            │
│ - work/hotstar/compensation │
│   for salary/equity docs    │
│ - life/gov docs for IDs     │
└─────────────────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ Agent thinks:               │
│ "W2 is a tax document from  │
│  employer. Let me check     │
│  the folder structure."     │
│                             │
│ → calls get_folder_tree(2)  │
└─────────────────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ Folder tree shows:          │
│ - work/hotstar/compensation │
│ - work/hotstar/worklog      │
│ - life/gov docs             │
└─────────────────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ Agent thinks:               │
│ "W2 from work, should go    │
│  to work/hotstar/           │
│  compensation based on      │
│  guideline pattern."        │
│                             │
│ → calls suggest_organization│
│   (file="inbox/W2_2024.pdf",│
│    target="work/hotstar/    │
│           compensation/",   │
│    reasoning="W2 is a tax   │
│      form from your         │
│      employer...",          │
│    confidence=0.92)         │
└─────────────────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ Suggestion created,         │
│ User sees:                  │
│                             │
│ "This looks like a W2 tax   │
│  form. Based on your        │
│  patterns, I'd suggest      │
│  moving it to work/hotstar/ │
│  compensation/              │
│                             │
│  [Move] [Keep in Inbox]     │
│  [Choose Different Folder]" │
└─────────────────────────────┘
```

---

## Complete Request Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                         COMPLETE REQUEST FLOW                          │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  User Input: "find my passport photo"                                  │
│       │                                                                │
│       ▼                                                                │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ STAGE 1: Fast Router (~150ms)                                    │  │
│  │                                                                   │  │
│  │ Input: message + context + pending_actions                       │  │
│  │ Model: gpt-4o-mini                                               │  │
│  │ Output: {intent: "query", confidence: 0.95,                      │  │
│  │          params: {search_query: "passport photo"}}               │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│       │                                                                │
│       ▼                                                                │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ STAGE 2: Query Agent (~1-3s)                                     │  │
│  │                                                                   │  │
│  │ Model: gpt-4o                                                    │  │
│  │ Tools: search_files, get_file_content, respond_to_user          │  │
│  │                                                                   │  │
│  │ Turn 1: Agent calls search_files("passport photo", type=image)  │  │
│  │ Turn 2: Agent calls respond_to_user(message, files)             │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│       │                                                                │
│       ▼                                                                │
│  Response: "I found your passport photo from March 2023:"             │
│            [passport_scan.jpg]                                         │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Handling Edge Cases

### Low Confidence Classification

When the router is uncertain:

```go
func (r *Router) handleLowConfidence(output *RouterOutput, input RouterInput) *RouterOutput {
    if output.Confidence < 0.6 {
        // For very low confidence, default to chat (safe fallback)
        // The chat handler can ask for clarification
        return &RouterOutput{
            Intent:     IntentChat,
            Confidence: 0.5,
            Params:     map[string]string{"fallback": "true"},
        }
    }
    return output
}
```

### Agent Handoff

Sometimes an agent needs to hand off to another:

```go
// Query agent discovers user wants to organize
type HandoffAction struct {
    ToAgent IntentType
    Reason  string
    Context map[string]any
}

// In query agent:
if userWantsToOrganize(response) {
    return &AgentResponse{
        Actions: []Action{
            HandoffAction{
                ToAgent: IntentOrganize,
                Reason:  "User asked to move the found file",
                Context: map[string]any{"file": foundFile},
            },
        },
    }
}
```

### Conversation Context Window

Keep conversation context manageable:

```go
func (c *ConversationContext) GetRecentMessages(limit int) []Message {
    // Return last N messages for context
    // Prioritize: user messages, agent responses with files
    // Truncate long content
}

func (c *ConversationContext) Summarize() string {
    // For very long conversations, summarize older parts
    // Keep recent messages verbatim
}
```

```go
// backend/agent/executor.go

type AgentExecutor struct {
    db        *db.DB
    fs        *fs.Service
    search    *SearchService
    openai    *vendors.OpenAIClient
    tools     map[string]Tool
}

type Tool interface {
    Name() string
    Description() string
    Execute(ctx context.Context, params ToolParams) (ToolResult, error)
}

type ToolParams struct {
    Query           string                 // User's message
    Intent          Intent                 // Classified intent
    Conversation    *ConversationContext   // Full conversation history
    ExtraParams     map[string]interface{} // Tool-specific params
}

type ToolResult struct {
    MessageType     string      // 'text', 'search_result', 'suggestion', etc.
    Content         interface{} // Structured content for the message
    SideEffects     []SideEffect // Actions taken (file moves, etc.)
}
```

### Core Tools

#### 1. SearchTool
```go
// Searches files using keyword + semantic search
// Returns formatted results with relevance and context

func (t *SearchTool) Execute(ctx context.Context, params ToolParams) (ToolResult, error) {
    // 1. Extract search terms from natural language query
    searchQuery := extractSearchTerms(params.Query)

    // 2. Run combined keyword + semantic search
    results := t.search.Search(searchQuery, SearchOptions{
        Types: []string{"keyword", "semantic"},
        Limit: 10,
    })

    // 3. If results are ambiguous, consider follow-up questions
    if needsClarification(results) {
        return askClarification(results)
    }

    // 4. Format results for display
    return formatSearchResults(results)
}
```

#### 2. OrganizeTool
```go
// Suggests organization for inbox files
// Uses guideline.md + existing folder structure

func (t *OrganizeTool) Execute(ctx context.Context, params ToolParams) (ToolResult, error) {
    // 1. Get file info and digest content
    file := t.db.GetFile(params.FilePath)
    digests := t.db.GetDigests(params.FilePath)

    // 2. Read guideline.md for folder structure
    guideline := t.fs.ReadFile("guideline.md")

    // 3. Get existing folder tree
    tree := t.fs.GetFolderTree(2) // depth 2

    // 4. Ask LLM for organization suggestion
    suggestion := t.llmSuggestFolder(file, digests, guideline, tree)

    // 5. Create pending suggestion
    suggestionID := t.db.CreateSuggestion(...)

    return ToolResult{
        MessageType: "suggestion",
        Content: suggestion,
    }
}
```

#### 3. MoveFileTool
```go
// Executes file move after user confirmation

func (t *MoveFileTool) Execute(ctx context.Context, params ToolParams) (ToolResult, error) {
    // 1. Verify suggestion exists and is pending
    suggestion := t.db.GetSuggestion(params.SuggestionID)

    // 2. Execute move via FS service
    err := t.fs.MoveFile(suggestion.FilePath, suggestion.TargetFolder)

    // 3. Update suggestion status
    t.db.UpdateSuggestionStatus(suggestion.ID, "accepted")

    // 4. Return confirmation message
    return ToolResult{
        MessageType: "action_result",
        Content: ActionResult{
            Action: "move",
            Success: true,
            Details: fmt.Sprintf("Moved %s to %s", ...),
        },
    }
}
```

#### 4. SummarizeTool
```go
// Summarizes file content or search results

func (t *SummarizeTool) Execute(ctx context.Context, params ToolParams) (ToolResult, error) {
    // 1. Get content to summarize
    content := t.getContentForSummary(params)

    // 2. Generate summary via LLM
    summary := t.llmSummarize(content, params.Query)

    return ToolResult{
        MessageType: "summary",
        Content: SummaryContent{
            Text: summary,
            Sources: content.Sources,
        },
    }
}
```

#### 5. AnswerTool
```go
// Answers general questions about the user's data

func (t *AnswerTool) Execute(ctx context.Context, params ToolParams) (ToolResult, error) {
    // 1. Gather relevant context
    //    - Recent inbox items
    //    - Search results if query mentions specific content
    //    - Stats (file counts, types, etc.)

    // 2. Generate conversational answer
    answer := t.llmAnswer(params.Query, context)

    return ToolResult{
        MessageType: "text",
        Content: TextContent{Text: answer},
    }
}
```

---

## Auto-Organization Flow

When a new file arrives in inbox:

```
┌──────────────────────────────────────────────────────────────────┐
│                    AUTO-ORGANIZATION FLOW                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. File Added to Inbox                                          │
│         │                                                        │
│         ▼                                                        │
│  2. Digest Worker Processes File                                 │
│     - Extract text (OCR, transcription)                          │
│     - Generate description                                       │
│     - Create embeddings                                          │
│         │                                                        │
│         ▼                                                        │
│  3. Organization Worker Triggered (after digests complete)       │
│     - Read guideline.md                                          │
│     - Analyze file content                                       │
│     - Match against folder patterns                              │
│         │                                                        │
│         ▼                                                        │
│  4. Generate Suggestion                                          │
│     ┌─────────────────────────────────────────────────────┐      │
│     │ "This looks like an ID document. Move to            │      │
│     │  life/gov docs/? [Yes] [No] [Choose folder...]"     │      │
│     └─────────────────────────────────────────────────────┘      │
│         │                                                        │
│         ▼                                                        │
│  5. Wait for User Response                                       │
│     - [Yes] → Execute move                                       │
│     - [No] → Keep in inbox, mark suggestion rejected             │
│     - [Choose folder] → Show folder picker                       │
│         │                                                        │
│         ▼                                                        │
│  6. Learn from Decision                                          │
│     - Track acceptance/rejection patterns                        │
│     - Consider updating guideline.md for repeated patterns       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Configuration Options

```go
// Settings stored in settings table

type OrganizationSettings struct {
    // Auto-suggest mode
    AutoSuggest       bool    `json:"autoSuggest"`       // Enable auto-suggestions
    SuggestThreshold  float64 `json:"suggestThreshold"`  // Min confidence (0.8)

    // Auto-move mode (for power users)
    AutoMove          bool    `json:"autoMove"`          // Auto-move without asking
    AutoMoveThreshold float64 `json:"autoMoveThreshold"` // Min confidence (0.95)

    // Folders to consider
    TargetFolders     []string `json:"targetFolders"`    // Whitelist of folders
    ExcludeFolders    []string `json:"excludeFolders"`   // Blacklist
}
```

---

## Conversational Query Flow

When user sends a text message:

```
┌──────────────────────────────────────────────────────────────────┐
│                  CONVERSATIONAL QUERY FLOW                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. User Message Received                                        │
│     "find my ID license photo"                                   │
│         │                                                        │
│         ▼                                                        │
│  2. Create/Continue Conversation                                 │
│     - New conversation if no active one                          │
│     - Continue existing if within time window (30 min)           │
│         │                                                        │
│         ▼                                                        │
│  3. Intent Classification                                        │
│     - Input: message + conversation history                      │
│     - Output: intent=file_search, params={type: image, ...}      │
│         │                                                        │
│         ▼                                                        │
│  4. Tool Selection & Execution                                   │
│     - Select: SearchTool                                         │
│     - Execute with conversation context                          │
│         │                                                        │
│         ▼                                                        │
│  5. Response Generation                                          │
│     ┌─────────────────────────────────────────────────────┐      │
│     │ "I found 3 photos that might be your ID license:"   │      │
│     │                                                     │      │
│     │ [ID_card.jpg]  [drivers_license.png]  [passport.jpg]│      │
│     │                                                     │      │
│     │ The first one looks most likely - it's in your      │      │
│     │ gov docs folder from last year.                     │      │
│     └─────────────────────────────────────────────────────┘      │
│         │                                                        │
│         ▼                                                        │
│  6. Follow-up Ready                                              │
│     User: "not that one, the driver's license"                   │
│     → Context aware, can narrow results                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Multi-Turn Conversation

The agent maintains conversation context for natural follow-ups:

```typescript
// Example conversation

User: "find my tax documents"
Agent: "I found 5 tax-related documents:
        - 2023_W2.pdf (work/compensation/)
        - 2023_1099.pdf (work/compensation/)
        - tax_return_2022.pdf (documents/)
        - tax_return_2023.pdf (documents/)
        - property_tax_2024.pdf (life/homelab/)

        Which year are you looking for?"

User: "2023"
Agent: "Here are your 2023 tax documents:
        [2023_W2.pdf] [2023_1099.pdf] [tax_return_2023.pdf]"

User: "what's in the W2"
Agent: "Your 2023 W2 from Hotstar shows:
        - Gross wages: $XXX,XXX
        - Federal tax withheld: $XX,XXX
        - State tax withheld: $X,XXX

        This was uploaded on Dec 15, 2023."
```

---

## API Implementation

### Main Message Handler

```go
// backend/api/inbox_agent.go

func (h *Handlers) HandleInboxMessage(c *gin.Context) {
    var req struct {
        Message string `json:"message" binding:"required"`
    }
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(400, gin.H{"error": "message required"})
        return
    }

    ctx := c.Request.Context()

    // Get or create conversation
    conv, err := h.getOrCreateConversation(ctx)
    if err != nil {
        c.JSON(500, gin.H{"error": "failed to get conversation"})
        return
    }

    // Save user message
    userMsg := h.saveUserMessage(ctx, conv.ID, req.Message)

    // Get conversation context
    convCtx := h.getConversationContext(ctx, conv.ID)

    // ═══════════════════════════════════════════════════════════════
    // STAGE 1: Fast Router (~150ms)
    // ═══════════════════════════════════════════════════════════════
    routerOutput, err := h.server.AgentRouter().Classify(ctx, router.RouterInput{
        Message:       req.Message,
        Context:       convCtx,
        PendingAction: h.getPendingSuggestion(ctx, conv.ID),
    })
    if err != nil {
        log.Error().Err(err).Msg("router classification failed")
        // Fallback to chat intent
        routerOutput = &router.RouterOutput{Intent: router.IntentChat, Confidence: 0.5}
    }

    log.Info().
        Str("intent", string(routerOutput.Intent)).
        Float64("confidence", routerOutput.Confidence).
        Msg("intent classified")

    // ═══════════════════════════════════════════════════════════════
    // Handle intents that don't need agents
    // ═══════════════════════════════════════════════════════════════

    switch routerOutput.Intent {
    case router.IntentSave:
        // Pure data capture - save and optionally trigger organization
        h.handleSaveIntent(c, conv, req.Message)
        return

    case router.IntentConfirm:
        // Execute pending suggestion
        h.handleConfirmIntent(c, conv, convCtx)
        return

    case router.IntentReject:
        // Cancel pending suggestion
        h.handleRejectIntent(c, conv, convCtx)
        return

    case router.IntentChat:
        // Simple response without agent
        h.handleChatIntent(c, conv, req.Message)
        return
    }

    // ═══════════════════════════════════════════════════════════════
    // STAGE 2: Specialized Agent (~1-5s)
    // ═══════════════════════════════════════════════════════════════

    agent, ok := h.server.AgentRegistry().GetAgent(routerOutput.Intent)
    if !ok {
        c.JSON(500, gin.H{"error": "no agent for intent"})
        return
    }

    // Stream response if client supports it
    if c.GetHeader("Accept") == "text/event-stream" {
        h.streamAgentResponse(c, agent, conv, routerOutput, convCtx)
        return
    }

    // Otherwise return complete response
    response, err := agent.Handle(ctx, agent.AgentRequest{
        Message:      req.Message,
        Intent:       routerOutput.Intent,
        Params:       routerOutput.Params,
        Conversation: convCtx,
    })
    if err != nil {
        c.JSON(500, gin.H{"error": "agent failed"})
        return
    }

    // Save agent response messages
    for _, msg := range response.Messages {
        h.saveAgentMessage(ctx, conv.ID, msg)
    }

    // Execute any actions
    for _, action := range response.Actions {
        h.executeAction(ctx, conv.ID, action)
    }

    c.JSON(200, gin.H{
        "conversation_id": conv.ID,
        "messages":        response.Messages,
    })
}
```

### Streaming Responses

For better UX, stream agent responses as they're generated:

```go
func (h *Handlers) streamAgentResponse(
    c *gin.Context,
    agent agent.Agent,
    conv *Conversation,
    routerOutput *router.RouterOutput,
    convCtx *ConversationContext,
) {
    c.Header("Content-Type", "text/event-stream")
    c.Header("Cache-Control", "no-cache")
    c.Header("Connection", "keep-alive")

    // Create streaming callback
    streamCh := make(chan agent.StreamEvent, 10)

    go func() {
        defer close(streamCh)
        agent.HandleStreaming(c.Request.Context(), agent.AgentRequest{
            Message:      convCtx.LastUserMessage(),
            Intent:       routerOutput.Intent,
            Params:       routerOutput.Params,
            Conversation: convCtx,
        }, streamCh)
    }()

    c.Stream(func(w io.Writer) bool {
        select {
        case event, ok := <-streamCh:
            if !ok {
                return false
            }

            switch e := event.(type) {
            case agent.ToolCallEvent:
                // Agent is calling a tool
                fmt.Fprintf(w, "event: tool_call\ndata: %s\n\n", e.JSON())

            case agent.ToolResultEvent:
                // Tool returned a result
                fmt.Fprintf(w, "event: tool_result\ndata: %s\n\n", e.JSON())

            case agent.TextDeltaEvent:
                // Streaming text response
                fmt.Fprintf(w, "event: text_delta\ndata: %s\n\n", e.JSON())

            case agent.MessageCompleteEvent:
                // Final message
                h.saveAgentMessage(c.Request.Context(), conv.ID, e.Message)
                fmt.Fprintf(w, "event: message\ndata: %s\n\n", e.JSON())

            case agent.DoneEvent:
                fmt.Fprintf(w, "event: done\ndata: {}\n\n")
                return false
            }

            c.Writer.Flush()
            return true

        case <-c.Request.Context().Done():
            return false
        }
    })
}
```

---

## API Endpoints

### Conversation Endpoints

```go
// List conversations
GET /api/inbox/conversations
    ?status=active,completed,archived
    &limit=20
    &cursor=...

// Get conversation with messages
GET /api/inbox/conversations/:id
    ?limit=50  // messages to return

// Create new conversation (or get active one)
POST /api/inbox/conversations
    { "message": "find my ID photo" }  // Optional initial message

// Send message to conversation
POST /api/inbox/conversations/:id/messages
    {
        "type": "text",
        "content": { "text": "find my ID photo" }
    }

// Archive conversation
POST /api/inbox/conversations/:id/archive
```

### Organization Endpoints

```go
// Get pending suggestions
GET /api/inbox/suggestions
    ?status=pending

// Respond to suggestion
POST /api/inbox/suggestions/:id/respond
    {
        "action": "accept" | "reject" | "choose",
        "targetFolder": "life/gov docs/"  // Only if action=choose
    }

// Manually request organization suggestions for inbox
POST /api/inbox/organize
    {
        "paths": ["inbox/file1.pdf", "inbox/file2.jpg"],  // Optional, defaults to all
        "force": false  // Re-suggest even if previously rejected
    }
```

### Settings Endpoints

```go
// Get organization settings
GET /api/settings/organization

// Update organization settings
PUT /api/settings/organization
    {
        "autoSuggest": true,
        "suggestThreshold": 0.8,
        ...
    }
```

---

## Frontend Components

### InboxFeed (Enhanced)

```tsx
// frontend/app/components/inbox-feed.tsx

type InboxItem =
    | FileItem           // Existing file cards
    | ConversationItem;  // New message items

interface ConversationItem {
    type: 'conversation';
    id: string;
    messages: Message[];
}

interface Message {
    id: string;
    role: 'user' | 'agent' | 'system';
    type: 'text' | 'search_result' | 'suggestion' | 'action_result' | ...;
    content: MessageContent;
    createdAt: string;
}

// Render mixed feed of files and conversation messages
function InboxFeed() {
    const { items, isLoading } = useInboxFeed();

    return (
        <div className="space-y-4">
            {items.map(item => (
                item.type === 'file'
                    ? <FileCard key={item.path} file={item} />
                    : <ConversationMessages key={item.id} conversation={item} />
            ))}
        </div>
    );
}
```

### Message Components

```tsx
// Agent message with search results
function SearchResultMessage({ message }: { message: Message }) {
    const { results, query, totalFound } = message.content;

    return (
        <div className="agent-message">
            <p>Found {totalFound} matches for "{query}":</p>
            <div className="grid gap-2">
                {results.map(result => (
                    <FilePreviewCard
                        key={result.path}
                        path={result.path}
                        matchContext={result.matchContext}
                    />
                ))}
            </div>
        </div>
    );
}

// Organization suggestion message
function SuggestionMessage({ message }: { message: Message }) {
    const { suggestionId, fileName, targetFolder, reasoning, confidence } = message.content;
    const respondMutation = useRespondToSuggestion();

    return (
        <div className="agent-message suggestion">
            <p>{reasoning}</p>
            <div className="flex gap-2 mt-2">
                <Button onClick={() => respondMutation.mutate({ id: suggestionId, action: 'accept' })}>
                    Move to {targetFolder}
                </Button>
                <Button variant="outline" onClick={() => respondMutation.mutate({ id: suggestionId, action: 'reject' })}>
                    Keep in Inbox
                </Button>
                <FolderPicker onSelect={(folder) => respondMutation.mutate({ id: suggestionId, action: 'choose', targetFolder: folder })} />
            </div>
        </div>
    );
}
```

### Input Enhancement

```tsx
// Enhanced input that handles both files and messages
function InboxInput() {
    const [text, setText] = useState('');
    const sendMessage = useSendMessage();
    const uploadFile = useUploadFile();

    const handleSubmit = async (e) => {
        e.preventDefault();

        if (text.trim()) {
            // Send as conversational message
            await sendMessage.mutateAsync({ text });
            setText('');
        }
    };

    return (
        <form onSubmit={handleSubmit}>
            <OmniInput
                value={text}
                onChange={setText}
                onFilesDrop={uploadFile}
                placeholder="Send files, URLs, or ask a question..."
            />
        </form>
    );
}
```

---

## Backend Components

### New Package Structure

```
backend/
├── agent/
│   ├── agent.go           # Agent interface and base types
│   ├── registry.go        # Agent registry
│   ├── conversation.go    # Conversation management
│   │
│   ├── router/
│   │   ├── router.go      # Fast intent classifier
│   │   ├── prompts.go     # Router prompts
│   │   └── rules.go       # Fast-path rule matching
│   │
│   ├── query/
│   │   ├── agent.go       # Query agent implementation
│   │   ├── tools.go       # Query-specific tools
│   │   └── prompts.go     # Query agent prompts
│   │
│   ├── organize/
│   │   ├── agent.go       # Organize agent implementation
│   │   ├── tools.go       # Organize-specific tools
│   │   └── prompts.go     # Organize agent prompts
│   │
│   └── common/
│       ├── tools.go       # Shared tools (respond_to_user, etc.)
│       └── llm.go         # LLM client wrapper with tool calling
│
├── workers/
│   └── organization/
│       └── worker.go      # Background auto-organization worker
```

### Server Integration

```go
// backend/server/server.go

type Server struct {
    // ... existing fields ...

    agentRouter    *router.Router       // Fast intent classifier
    agentRegistry  *agent.Registry      // Specialized agents
    orgWorker      *organization.Worker // Background organization
}

func New(cfg *Config) (*Server, error) {
    // ... existing initialization ...

    // Stage 1: Initialize fast router
    s.agentRouter = router.NewRouter(router.Config{
        Model:  cfg.RouterModel,  // e.g., "gpt-4o-mini"
        OpenAI: s.openaiClient,
    })

    // Stage 2: Initialize specialized agents
    agentConfig := agent.Config{
        Model:  cfg.AgentModel,  // e.g., "gpt-4o"
        DB:     s.database,
        FS:     s.fsService,
        Search: s.searchService,
        OpenAI: s.openaiClient,
    }

    s.agentRegistry = agent.NewRegistry(agentConfig)

    // Background worker for auto-organization
    s.orgWorker = organization.NewWorker(organization.Config{
        DB:       s.database,
        Registry: s.agentRegistry,
        Notif:    s.notifService,
        Router:   s.agentRouter,  // Reuse router for background tasks
    })

    // Wire digest completion to organization worker
    s.digestWorker.SetCompletionHandler(func(filePath string) {
        if isInInbox(filePath) {
            s.orgWorker.OnDigestComplete(filePath)
        }
    })
}

// Expose for API handlers
func (s *Server) AgentRouter() *router.Router { return s.agentRouter }
func (s *Server) AgentRegistry() *agent.Registry { return s.agentRegistry }
```

### Configuration

```go
// backend/config/config.go

type AgentConfig struct {
    // Router (Stage 1)
    RouterModel      string  `env:"AGENT_ROUTER_MODEL" default:"gpt-4o-mini"`
    RouterMaxTokens  int     `env:"AGENT_ROUTER_MAX_TOKENS" default:"100"`

    // Agents (Stage 2)
    AgentModel       string  `env:"AGENT_MODEL" default:"gpt-4o"`
    AgentMaxTokens   int     `env:"AGENT_MAX_TOKENS" default:"4096"`
    AgentMaxTurns    int     `env:"AGENT_MAX_TURNS" default:"10"`

    // Auto-organization
    AutoOrganize     bool    `env:"AGENT_AUTO_ORGANIZE" default:"false"`
    OrganizeMinConf  float64 `env:"AGENT_ORGANIZE_MIN_CONFIDENCE" default:"0.8"`
}
```

---

## Extension Points

### Adding New Tools

1. Create tool in `backend/agent/tools/`
2. Implement `Tool` interface
3. Register in executor's tool registry
4. Update intent classification if needed

### Adding New Message Types

1. Add type constant to message types
2. Define content structure
3. Create frontend component for rendering
4. Update message serialization

### Learning from User Decisions

The system can improve over time:

```go
// Track patterns in organization decisions
type OrganizationPattern struct {
    FilePattern   string   // e.g., "*.pdf with 'W2' in content"
    TargetFolder  string   // e.g., "work/compensation/"
    SuccessRate   float64  // Acceptance rate
    SampleCount   int      // Number of decisions
}

// After enough positive examples, could:
// 1. Increase confidence for similar files
// 2. Suggest adding pattern to guideline.md
// 3. Enable auto-move for high-confidence patterns
```

---

## Model Selection

### Recommended Models

| Stage | Purpose | Recommended | Alternatives |
|-------|---------|-------------|--------------|
| **Router** | Intent classification | `gpt-4o-mini` | `claude-3-haiku`, local fine-tuned |
| **Query Agent** | Search & answer | `gpt-4o` | `claude-3-5-sonnet`, `gpt-4-turbo` |
| **Organize Agent** | File organization | `gpt-4o` | `claude-3-5-sonnet`, `gpt-4-turbo` |

### Cost/Latency Tradeoffs

```
┌─────────────────────────────────────────────────────────────────────┐
│                    MODEL SELECTION TRADEOFFS                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Router (Stage 1):                                                  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ gpt-4o-mini     │ ~$0.15/1M tokens │ ~150ms │ Good accuracy  │  │
│  │ claude-3-haiku  │ ~$0.25/1M tokens │ ~200ms │ Good accuracy  │  │
│  │ local model     │ Free             │ ~50ms  │ Needs training │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Agents (Stage 2):                                                  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ gpt-4o          │ ~$5/1M tokens    │ ~1-3s  │ Best tools     │  │
│  │ claude-3-5-son. │ ~$3/1M tokens    │ ~1-2s  │ Best reasoning │  │
│  │ gpt-4o-mini     │ ~$0.15/1M tokens │ ~500ms │ Good enough?   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Recommendation:                                                    │
│  - Start with gpt-4o-mini for router (fast, cheap, accurate)       │
│  - Use gpt-4o for agents (best tool calling)                       │
│  - Consider claude-3-5-sonnet if reasoning quality matters more    │
│  - Evaluate gpt-4o-mini for agents if cost is a concern            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Future: Local Router

For even faster routing, consider a local fine-tuned model:

```go
// Option for future: local classifier
type LocalRouter struct {
    // Fine-tuned DistilBERT or similar
    model *transformers.Model
}

func (r *LocalRouter) Classify(input string) (*RouterOutput, error) {
    // ~10-50ms latency
    // Trained on your intent dataset
    // Falls back to LLM for low confidence
}
```

---

## Implementation Phases

### Phase 1: Infrastructure & Router
- [ ] Database migrations (conversations, messages, suggestions tables)
- [ ] Fast router with gpt-4o-mini
- [ ] Intent classification (query, organize, save, confirm, reject, chat)
- [ ] Basic conversation CRUD API
- [ ] Wire router to inbox message endpoint

### Phase 2: Query Agent
- [ ] Query agent with tool calling
- [ ] Search tool (reuse existing search infrastructure)
- [ ] Get file content tool
- [ ] respond_to_user tool
- [ ] UI for showing agent responses in feed
- [ ] Streaming response support

### Phase 3: Organize Agent
- [ ] Organize agent with tool calling
- [ ] Folder tree tool
- [ ] Read guideline tool
- [ ] Suggest organization tool
- [ ] Move file tool
- [ ] Suggestion storage and confirm/reject flow
- [ ] Folder picker UI component

### Phase 4: Auto-Organization
- [ ] Organization worker (background)
- [ ] Wire to digest completion events
- [ ] Auto-suggestion based on settings
- [ ] SSE notifications for new suggestions
- [ ] Settings UI for organization preferences

### Phase 5: Polish & Advanced
- [ ] Multi-turn conversation improvements
- [ ] Agent handoff (query → organize)
- [ ] Learning from decisions
- [ ] Bulk organization
- [ ] Undo/history for moves
- [ ] Fallback handling for API failures

---

## Open Questions

1. **Router model choice** - gpt-4o-mini vs claude-3-haiku vs local fine-tuned? Need to benchmark accuracy and latency.

2. **Agent model choice** - Is gpt-4o-mini good enough for agents, or do we need gpt-4o/claude for quality?

3. **Conversation persistence** - How long to keep conversations? Archive after 24h of inactivity?

4. **Mixed feed order** - How to interleave files and messages? Chronological? Group by conversation?

5. **Suggestion expiry** - When to expire pending suggestions? After file is manually moved? After N days?

6. **Streaming vs blocking** - Should we always stream agent responses, or only for long-running queries?

7. **Fallback strategy** - What to do when OpenAI is down? Queue requests? Use backup model? Return error?

8. **Learning scope** - Should patterns learned from one user be shareable (for multi-user setups)?

9. **Rate limiting** - How to handle users who spam the agent? Per-user limits? Token budgets?

10. **Caching** - Can we cache router classifications for common patterns? (e.g., "yes" → confirm)

---

## Related Documents

- [digest-system.md](digest-system.md) - File processing pipeline
- [fs-service.md](fs-service.md) - Filesystem operations
- [claude-code.md](claude-code.md) - Reference for conversation UI patterns
- [notifications.md](notifications.md) - Real-time updates
