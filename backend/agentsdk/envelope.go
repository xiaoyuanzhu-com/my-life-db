package agentsdk

import (
	"encoding/json"
	"time"
)

// MarshalEnvelope creates a JSON WS frame with the given type, sessionId, and payload fields merged in.
func MarshalEnvelope(msgType string, sessionID string, payload map[string]any) ([]byte, error) {
	msg := make(map[string]any, len(payload)+3)
	for k, v := range payload {
		msg[k] = v
	}
	msg["type"] = msgType
	msg["sessionId"] = sessionID
	msg["ts"] = time.Now().UnixMilli()
	return json.Marshal(msg)
}

// SessionInfoEnvelope creates a session.info frame.
func SessionInfoEnvelope(sessionID string, totalMessages int, isProcessing bool) ([]byte, error) {
	return MarshalEnvelope("session.info", sessionID, map[string]any{
		"totalMessages": totalMessages,
		"isProcessing":  isProcessing,
	})
}

// TurnStartEnvelope creates a turn.start frame.
func TurnStartEnvelope(sessionID string) ([]byte, error) {
	return MarshalEnvelope("turn.start", sessionID, nil)
}

// TurnCompleteEnvelope creates a turn.complete frame.
func TurnCompleteEnvelope(sessionID string, stopReason string) ([]byte, error) {
	return MarshalEnvelope("turn.complete", sessionID, map[string]any{
		"stopReason": stopReason,
	})
}

// UserEchoEnvelope creates a user.echo frame.
func UserEchoEnvelope(sessionID string, content []map[string]any) ([]byte, error) {
	return MarshalEnvelope("user.echo", sessionID, map[string]any{
		"content": content,
	})
}

// ErrorEnvelope creates an error frame.
func ErrorEnvelope(sessionID string, message string, code string) ([]byte, error) {
	return MarshalEnvelope("error", sessionID, map[string]any{
		"message": message,
		"code":    code,
	})
}

// AgentMessageChunkEnvelope creates an agent.messageChunk frame from ACP AgentMessageChunk.
func AgentMessageChunkEnvelope(sessionID string, content any) ([]byte, error) {
	return MarshalEnvelope("agent.messageChunk", sessionID, map[string]any{
		"content": content,
	})
}

// AgentThoughtChunkEnvelope creates an agent.thoughtChunk frame.
func AgentThoughtChunkEnvelope(sessionID string, content any) ([]byte, error) {
	return MarshalEnvelope("agent.thoughtChunk", sessionID, map[string]any{
		"content": content,
	})
}

// AgentToolCallEnvelope creates an agent.toolCall frame from ACP ToolCall fields.
func AgentToolCallEnvelope(sessionID string, fields map[string]any) ([]byte, error) {
	return MarshalEnvelope("agent.toolCall", sessionID, fields)
}

// AgentToolCallUpdateEnvelope creates an agent.toolCallUpdate frame.
func AgentToolCallUpdateEnvelope(sessionID string, fields map[string]any) ([]byte, error) {
	return MarshalEnvelope("agent.toolCallUpdate", sessionID, fields)
}

// AgentPlanEnvelope creates an agent.plan frame from ACP Plan entries.
func AgentPlanEnvelope(sessionID string, entries []PlanEntry) ([]byte, error) {
	return MarshalEnvelope("agent.plan", sessionID, map[string]any{
		"entries": entries,
	})
}

// PermissionRequestEnvelope creates a permission.request frame.
func PermissionRequestEnvelope(sessionID string, toolCall map[string]any, options []map[string]any) ([]byte, error) {
	return MarshalEnvelope("permission.request", sessionID, map[string]any{
		"toolCall": toolCall,
		"options":  options,
	})
}

// SessionModeUpdateEnvelope creates a session.modeUpdate frame.
func SessionModeUpdateEnvelope(sessionID string, modeID string, availableModes any) ([]byte, error) {
	payload := map[string]any{"modeId": modeID}
	if availableModes != nil {
		payload["availableModes"] = availableModes
	}
	return MarshalEnvelope("session.modeUpdate", sessionID, payload)
}

// SessionModelsUpdateEnvelope creates a session.modelsUpdate frame.
func SessionModelsUpdateEnvelope(sessionID string, modelID string, availableModels any) ([]byte, error) {
	payload := map[string]any{"modelId": modelID}
	if availableModels != nil {
		payload["availableModels"] = availableModels
	}
	return MarshalEnvelope("session.modelsUpdate", sessionID, payload)
}

// SessionCommandsUpdateEnvelope creates a session.commandsUpdate frame.
func SessionCommandsUpdateEnvelope(sessionID string, commands any) ([]byte, error) {
	return MarshalEnvelope("session.commandsUpdate", sessionID, map[string]any{
		"commands": commands,
	})
}
