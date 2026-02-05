package agent

import "time"

// Conversation represents an agent conversation
type Conversation struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Status    string    `json:"status"` // active, completed, archived
	Summary   string    `json:"summary,omitempty"`
	Messages  []Message `json:"messages,omitempty"`
}

// Message represents a message in a conversation
type Message struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	Role           string    `json:"role"` // user, assistant
	Content        string    `json:"content"`
	ToolUse        []ToolUse `json:"tool_use,omitempty"`
	ToolResultID   string    `json:"tool_result_id,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

// ToolUse represents a tool call by the agent
type ToolUse struct {
	ID    string                 `json:"id"`
	Name  string                 `json:"name"`
	Input map[string]interface{} `json:"input"`
}

// FileIntention represents the agent's analysis of a file's purpose
type FileIntention struct {
	ID               string    `json:"id"`
	FilePath         string    `json:"file_path"`
	ConversationID   string    `json:"conversation_id,omitempty"`
	IntentionType    string    `json:"intention_type"` // document, receipt, note, photo, etc.
	IntentionDetails string    `json:"intention_details,omitempty"`
	Confidence       float64   `json:"confidence"`
	SuggestedFolder  string    `json:"suggested_folder,omitempty"`
	Reasoning        string    `json:"reasoning,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// Suggestion represents a pending organization action
type Suggestion struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	FilePath       string    `json:"file_path"`
	TargetFolder   string    `json:"target_folder"`
	Reasoning      string    `json:"reasoning"`
	Confidence     float64   `json:"confidence"`
	Status         string    `json:"status"` // pending, accepted, rejected, expired
	CreatedAt      time.Time `json:"created_at"`
	ResolvedAt     *time.Time `json:"resolved_at,omitempty"`
}

// Request is an incoming agent request
type Request struct {
	ConversationID string `json:"conversation_id,omitempty"`
	Text           string `json:"text"`
}

// Response is the agent's response
type Response struct {
	ConversationID string         `json:"conversation_id"`
	Text           string         `json:"text"`
	Artifacts      []Artifact     `json:"artifacts,omitempty"`
	Intention      *FileIntention `json:"intention,omitempty"`
	Suggestion     *Suggestion    `json:"suggestion,omitempty"`
}

// Artifact represents additional data returned with a response
type Artifact struct {
	Type string      `json:"type"` // file, folder, etc.
	Data interface{} `json:"data"`
}
