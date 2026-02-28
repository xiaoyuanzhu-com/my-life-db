package sdk

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/claude/sdk/transport"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Query handles the bidirectional control protocol on top of Transport.
// It manages control request/response routing, hook callbacks, and message streaming.
type Query struct {
	transport         transport.Transport
	isStreamingMode   bool
	canUseTool        CanUseToolFunc
	hooks             map[HookEvent][]HookMatcher
	initializeTimeout time.Duration

	// Control protocol state
	pendingResponses map[string]chan map[string]any
	pendingResults   map[string]any // Stores results or errors
	pendingMu        sync.RWMutex

	// Hook callback registry
	hookCallbacks   map[string]HookCallback
	nextCallbackID  atomic.Int64
	hookCallbacksMu sync.RWMutex

	// Message streaming (like Python SDK's dict[str, Any])
	messages chan map[string]any

	// Initialization
	initialized          bool
	initializationResult *ServerInfo
	firstResultEvent     chan struct{}

	// Request counter for unique IDs
	requestCounter atomic.Int64

	// Forwarded permissions waiting for external response via RespondToPermission()
	pendingPermissions   map[string]chan PermissionResult
	pendingPermissionsMu sync.Mutex

	// State
	closed   bool
	closedMu sync.RWMutex

	// Context
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// QueryOptions configures the Query
type QueryOptions struct {
	Transport         transport.Transport
	IsStreamingMode   bool
	CanUseTool        CanUseToolFunc
	Hooks             map[HookEvent][]HookMatcher
	InitializeTimeout time.Duration
}

// NewQuery creates a new Query with the given options
func NewQuery(opts QueryOptions) *Query {
	if opts.InitializeTimeout <= 0 {
		opts.InitializeTimeout = 60 * time.Second
	}

	return &Query{
		transport:         opts.Transport,
		isStreamingMode:   opts.IsStreamingMode,
		canUseTool:        opts.CanUseTool,
		hooks:             opts.Hooks,
		initializeTimeout: opts.InitializeTimeout,
		pendingResponses:   make(map[string]chan map[string]any),
		pendingResults:     make(map[string]any),
		pendingPermissions: make(map[string]chan PermissionResult),
		hookCallbacks:      make(map[string]HookCallback),
		messages:           make(chan map[string]any, 100),
		firstResultEvent:   make(chan struct{}),
	}
}

// Start begins reading messages from the transport
func (q *Query) Start(ctx context.Context) error {
	q.ctx, q.cancel = context.WithCancel(ctx)

	// Start message reader
	q.wg.Add(1)
	go q.readMessages()

	return nil
}

// Initialize performs the control protocol initialization handshake
func (q *Query) Initialize() (*ServerInfo, error) {
	if !q.isStreamingMode {
		return nil, nil
	}

	// Build hooks configuration
	var hooksConfig map[string]any
	if len(q.hooks) > 0 {
		hooksConfig = make(map[string]any)
		for event, matchers := range q.hooks {
			if len(matchers) == 0 {
				continue
			}

			var matcherConfigs []map[string]any
			for _, matcher := range matchers {
				callbackIDs := make([]string, 0, len(matcher.Hooks))
				for _, callback := range matcher.Hooks {
					callbackID := fmt.Sprintf("hook_%d", q.nextCallbackID.Add(1))
					q.hookCallbacksMu.Lock()
					q.hookCallbacks[callbackID] = callback
					q.hookCallbacksMu.Unlock()
					callbackIDs = append(callbackIDs, callbackID)
				}

				matcherConfig := map[string]any{
					"matcher":         matcher.Matcher,
					"hookCallbackIds": callbackIDs,
				}
				if matcher.Timeout != nil {
					matcherConfig["timeout"] = *matcher.Timeout
				}
				matcherConfigs = append(matcherConfigs, matcherConfig)
			}
			hooksConfig[string(event)] = matcherConfigs
		}
	}

	// Send initialize request
	request := map[string]any{
		"subtype": "initialize",
		"hooks":   hooksConfig,
	}

	log.Debug().Interface("request", request).Msg("sending initialize control request")

	response, err := q.sendControlRequest(request, q.initializeTimeout)
	if err != nil {
		return nil, fmt.Errorf("initialize failed: %w", err)
	}

	log.Debug().Interface("response", response).Msg("received initialize response")

	q.initialized = true

	// Parse server info from response
	serverInfo := &ServerInfo{}
	if commands, ok := response["commands"].([]any); ok {
		for _, cmd := range commands {
			if cmdMap, ok := cmd.(map[string]any); ok {
				serverInfo.Commands = append(serverInfo.Commands, cmdMap)
			}
		}
	}
	if style, ok := response["output_style"].(string); ok {
		serverInfo.OutputStyle = style
	}
	if styles, ok := response["output_styles"].([]any); ok {
		for _, s := range styles {
			if str, ok := s.(string); ok {
				serverInfo.OutputStyles = append(serverInfo.OutputStyles, str)
			}
		}
	}

	q.initializationResult = serverInfo

	log.Debug().
		Int("commands", len(serverInfo.Commands)).
		Str("outputStyle", serverInfo.OutputStyle).
		Msg("Claude SDK initialized")

	return serverInfo, nil
}

// readMessages reads from transport and routes messages appropriately
func (q *Query) readMessages() {
	defer q.wg.Done()
	defer close(q.messages)

	for {
		select {
		case <-q.ctx.Done():
			return

		case data, ok := <-q.transport.ReadMessages():
			if !ok {
				return
			}

			log.Debug().Str("raw", string(data)).Msg("SDK received message from Claude CLI")

			// Parse message type
			var msgBase struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(data, &msgBase); err != nil {
				log.Debug().Err(err).Msg("failed to parse message type")
				continue
			}

			switch msgBase.Type {
			case "control_response":
				q.handleControlResponse(data)

			case "control_request":
				go q.handleControlRequest(data)

			case "result":
				// Signal that we received first result
				select {
				case <-q.firstResultEvent:
				default:
					close(q.firstResultEvent)
				}
				// Also send as regular message
				q.forwardMessage(data)

			default:
				q.forwardMessage(data)
			}

		case err, ok := <-q.transport.Errors():
			if !ok {
				return
			}
			log.Error().Err(err).Msg("transport error")
		}
	}
}

// forwardMessage unmarshals and sends a message to the output channel.
// Like Python SDK's query.receive_messages() yielding dict[str, Any].
func (q *Query) forwardMessage(data []byte) {
	var msg map[string]any
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Debug().Err(err).Msg("failed to unmarshal message")
		return
	}
	select {
	case q.messages <- msg:
	case <-q.ctx.Done():
	}
}

// handleControlResponse routes control responses to waiting callers
func (q *Query) handleControlResponse(data []byte) {
	var resp struct {
		Response struct {
			Subtype   string         `json:"subtype"`
			RequestID string         `json:"request_id"`
			Response  map[string]any `json:"response,omitempty"`
			Error     string         `json:"error,omitempty"`
		} `json:"response"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		log.Debug().Err(err).Msg("failed to parse control response")
		return
	}

	requestID := resp.Response.RequestID

	q.pendingMu.Lock()
	ch, ok := q.pendingResponses[requestID]
	if ok {
		delete(q.pendingResponses, requestID)
	}
	q.pendingMu.Unlock()

	if !ok {
		log.Debug().Str("requestId", requestID).Msg("received response for unknown request")
		return
	}

	if resp.Response.Subtype == "error" {
		// Store error
		q.pendingMu.Lock()
		q.pendingResults[requestID] = fmt.Errorf("%s", resp.Response.Error)
		q.pendingMu.Unlock()
	} else {
		// Store result
		q.pendingMu.Lock()
		q.pendingResults[requestID] = resp.Response.Response
		q.pendingMu.Unlock()
	}

	// Signal completion
	close(ch)
}

// handleControlRequest processes incoming control requests from Claude
func (q *Query) handleControlRequest(data []byte) {
	var req ControlRequest
	if err := json.Unmarshal(data, &req); err != nil {
		log.Debug().Err(err).Msg("failed to parse control request")
		return
	}

	requestID := req.RequestID
	request := req.Request
	subtype, _ := request["subtype"].(string)

	log.Debug().
		Str("requestId", requestID).
		Str("subtype", subtype).
		Msg("handling control request")

	var responseData map[string]any
	var respErr error

	switch subtype {
	case "can_use_tool":
		// Try callback for fast-path (auto-allow/deny)
		responseData, respErr = q.handleCanUseTool(request)

		if responseData == nil && respErr == nil {
			// PermissionResultAsk — forward to message channel, wait for external decision
			responseData, respErr = q.forwardAndWaitForPermission(requestID, request, data)
		}

	case "hook_callback":
		responseData, respErr = q.handleHookCallback(request)

	default:
		respErr = fmt.Errorf("unknown control request subtype: %s", subtype)
	}

	// Send response back to Claude CLI
	q.sendControlResponse(requestID, responseData, respErr)
}

// forwardAndWaitForPermission forwards a control_request to the message channel
// and blocks until RespondToPermission() is called with the decision.
func (q *Query) forwardAndWaitForPermission(requestID string, request map[string]any, rawData []byte) (map[string]any, error) {
	// Register pending permission channel
	ch := make(chan PermissionResult, 1)
	q.pendingPermissionsMu.Lock()
	q.pendingPermissions[requestID] = ch
	q.pendingPermissionsMu.Unlock()

	defer func() {
		q.pendingPermissionsMu.Lock()
		delete(q.pendingPermissions, requestID)
		q.pendingPermissionsMu.Unlock()
	}()

	// Forward the original control_request to the message channel
	log.Debug().
		Str("requestId", requestID).
		Msg("forwarding control_request to message channel for external handling")
	q.forwardMessage(rawData)

	// Block until external response or shutdown
	select {
	case result := <-ch:
		log.Debug().
			Str("requestId", requestID).
			Msg("received external permission response")
		return q.permissionResultToResponse(result, request)
	case <-q.ctx.Done():
		return nil, q.ctx.Err()
	}
}

// sendControlResponse sends a control_response back to Claude CLI via stdin.
func (q *Query) sendControlResponse(requestID string, responseData map[string]any, respErr error) {
	response := ControlResponse{
		Type: "control_response",
	}
	response.Response.RequestID = requestID

	if respErr != nil {
		response.Response.Subtype = "error"
		response.Response.Error = respErr.Error()
	} else {
		response.Response.Subtype = "success"
		response.Response.Response = responseData
	}

	respJSON, err := json.Marshal(response)
	if err != nil {
		log.Error().Err(err).Msg("failed to marshal control response")
		return
	}

	if err := q.transport.Write(string(respJSON) + "\n"); err != nil {
		log.Error().Err(err).Msg("failed to send control response")
	}
}

// handleCanUseTool handles tool permission requests via the canUseTool callback.
// Returns (nil, nil) when the callback returns PermissionResultAsk, signaling
// that the request should be forwarded to the message channel.
func (q *Query) handleCanUseTool(request map[string]any) (map[string]any, error) {
	if q.canUseTool == nil {
		// No callback — forward all permission requests
		return nil, nil
	}

	toolName, _ := request["tool_name"].(string)
	input, _ := request["input"].(map[string]any)
	suggestions, _ := request["permission_suggestions"].([]any)

	// Build context
	ctx := ToolPermissionContext{
		Signal: nil,
	}
	for _, s := range suggestions {
		if sMap, ok := s.(map[string]any); ok {
			update := PermissionUpdate{}
			if t, ok := sMap["type"].(string); ok {
				update.Type = PermissionUpdateType(t)
			}
			ctx.Suggestions = append(ctx.Suggestions, update)
		}
	}

	// Call callback
	result, err := q.canUseTool(toolName, input, ctx)
	if err != nil {
		return nil, err
	}

	// PermissionResultAsk — signal caller to forward
	if _, ok := result.(PermissionResultAsk); ok {
		return nil, nil
	}

	return q.permissionResultToResponse(result, request)
}

// permissionResultToResponse converts a PermissionResult into the response map
// format expected by the Claude CLI control protocol.
func (q *Query) permissionResultToResponse(result PermissionResult, request map[string]any) (map[string]any, error) {
	input, _ := request["input"].(map[string]any)

	switch r := result.(type) {
	case PermissionResultAllow:
		resp := map[string]any{
			"behavior": "allow",
		}
		if r.UpdatedInput != nil {
			resp["updatedInput"] = r.UpdatedInput
		} else {
			resp["updatedInput"] = input
		}
		if len(r.UpdatedPermissions) > 0 {
			resp["updatedPermissions"] = r.UpdatedPermissions
		}
		return resp, nil

	case PermissionResultDeny:
		resp := map[string]any{
			"behavior": "deny",
			"message":  r.Message,
		}
		if r.Interrupt {
			resp["interrupt"] = true
		}
		return resp, nil

	default:
		return nil, fmt.Errorf("unknown permission result type")
	}
}

// handleHookCallback handles hook callback requests
func (q *Query) handleHookCallback(request map[string]any) (map[string]any, error) {
	callbackID, _ := request["callback_id"].(string)
	input := request["input"]
	toolUseID, _ := request["tool_use_id"].(string)

	q.hookCallbacksMu.RLock()
	callback, ok := q.hookCallbacks[callbackID]
	q.hookCallbacksMu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("no hook callback found for ID: %s", callbackID)
	}

	// Parse hook input based on event type
	var hookInput HookInput
	if inputMap, ok := input.(map[string]any); ok {
		eventName, _ := inputMap["hook_event_name"].(string)
		switch eventName {
		case "PreToolUse":
			hi := PreToolUseHookInput{HookEventName: eventName}
			hi.ToolName, _ = inputMap["tool_name"].(string)
			hi.ToolInput, _ = inputMap["tool_input"].(map[string]any)
			hi.SessionID, _ = inputMap["session_id"].(string)
			hi.TranscriptPath, _ = inputMap["transcript_path"].(string)
			hi.Cwd, _ = inputMap["cwd"].(string)
			hookInput = hi
		case "PostToolUse":
			hi := PostToolUseHookInput{HookEventName: eventName}
			hi.ToolName, _ = inputMap["tool_name"].(string)
			hi.ToolInput, _ = inputMap["tool_input"].(map[string]any)
			hi.ToolResponse = inputMap["tool_response"]
			hi.SessionID, _ = inputMap["session_id"].(string)
			hookInput = hi
		case "UserPromptSubmit":
			hi := UserPromptSubmitHookInput{HookEventName: eventName}
			hi.Prompt, _ = inputMap["prompt"].(string)
			hi.SessionID, _ = inputMap["session_id"].(string)
			hookInput = hi
		case "Stop", "SubagentStop":
			hi := StopHookInput{HookEventName: eventName}
			hi.StopHookActive, _ = inputMap["stop_hook_active"].(bool)
			hi.SessionID, _ = inputMap["session_id"].(string)
			hookInput = hi
		default:
			return nil, fmt.Errorf("unknown hook event: %s", eventName)
		}
	}

	// Call callback
	var toolUseIDPtr *string
	if toolUseID != "" {
		toolUseIDPtr = &toolUseID
	}

	output, err := callback(hookInput, toolUseIDPtr, HookContext{Signal: nil})
	if err != nil {
		return nil, err
	}

	// Convert output to response format
	resp := make(map[string]any)
	if output.Continue != nil {
		resp["continue"] = *output.Continue
	}
	if output.SuppressOutput {
		resp["suppressOutput"] = true
	}
	if output.StopReason != "" {
		resp["stopReason"] = output.StopReason
	}
	if output.Decision != "" {
		resp["decision"] = output.Decision
	}
	if output.SystemMessage != "" {
		resp["systemMessage"] = output.SystemMessage
	}
	if output.Reason != "" {
		resp["reason"] = output.Reason
	}
	if output.HookSpecificOutput != nil {
		resp["hookSpecificOutput"] = output.HookSpecificOutput
	}

	return resp, nil
}

// sendControlRequest sends a control request and waits for response
func (q *Query) sendControlRequest(request map[string]any, timeout time.Duration) (map[string]any, error) {
	if !q.isStreamingMode {
		return nil, ErrStreamingModeRequired
	}

	// Generate unique request ID
	requestID := q.generateRequestID()

	// Create response channel
	responseChan := make(chan struct{})
	q.pendingMu.Lock()
	q.pendingResponses[requestID] = make(chan map[string]any, 1)
	q.pendingMu.Unlock()

	// Build control request
	controlRequest := map[string]any{
		"type":       "control_request",
		"request_id": requestID,
		"request":    request,
	}

	reqJSON, err := json.Marshal(controlRequest)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal control request: %w", err)
	}

	log.Debug().Str("json", string(reqJSON)).Msg("SDK sending control request to Claude CLI")

	// Send request
	if err := q.transport.Write(string(reqJSON) + "\n"); err != nil {
		q.pendingMu.Lock()
		delete(q.pendingResponses, requestID)
		q.pendingMu.Unlock()
		return nil, fmt.Errorf("failed to send control request: %w", err)
	}

	// Wait for response
	q.pendingMu.RLock()
	ch := q.pendingResponses[requestID]
	q.pendingMu.RUnlock()

	// Use the channel we stored, not the local one
	_ = responseChan // unused, we wait on ch instead

	select {
	case <-ch:
		// Response received
		q.pendingMu.Lock()
		result := q.pendingResults[requestID]
		delete(q.pendingResults, requestID)
		q.pendingMu.Unlock()

		if err, ok := result.(error); ok {
			return nil, &ControlRequestError{
				RequestID: requestID,
				Subtype:   request["subtype"].(string),
				Message:   "request failed",
				Cause:     err,
			}
		}

		if respMap, ok := result.(map[string]any); ok {
			return respMap, nil
		}

		return nil, nil

	case <-time.After(timeout):
		q.pendingMu.Lock()
		delete(q.pendingResponses, requestID)
		delete(q.pendingResults, requestID)
		q.pendingMu.Unlock()
		return nil, &ControlRequestError{
			RequestID: requestID,
			Subtype:   request["subtype"].(string),
			Message:   "timeout waiting for response",
			Cause:     ErrTimeout,
		}

	case <-q.ctx.Done():
		return nil, q.ctx.Err()
	}
}

// generateRequestID creates a unique request ID
func (q *Query) generateRequestID() string {
	counter := q.requestCounter.Add(1)
	randBytes := make([]byte, 4)
	rand.Read(randBytes)
	return fmt.Sprintf("req_%d_%s", counter, hex.EncodeToString(randBytes))
}

// RespondToPermission provides the permission decision for a forwarded control_request.
// Called by the backend when the frontend/user has made a decision.
// The requestID must match the request_id from the original control_request.
func (q *Query) RespondToPermission(requestID string, result PermissionResult) error {
	q.pendingPermissionsMu.Lock()
	ch, ok := q.pendingPermissions[requestID]
	q.pendingPermissionsMu.Unlock()

	if !ok {
		return fmt.Errorf("no pending permission for request_id: %s", requestID)
	}

	select {
	case ch <- result:
		return nil
	default:
		return fmt.Errorf("permission channel full for request_id: %s", requestID)
	}
}

// PendingPermissionIDs returns the request IDs of all pending (forwarded) permission requests.
// Used by the backend to find requests to auto-approve when "always allow" is selected.
func (q *Query) PendingPermissionIDs() []string {
	q.pendingPermissionsMu.Lock()
	defer q.pendingPermissionsMu.Unlock()

	ids := make([]string, 0, len(q.pendingPermissions))
	for id := range q.pendingPermissions {
		ids = append(ids, id)
	}
	return ids
}

// Interrupt sends an interrupt signal to stop the current operation
func (q *Query) Interrupt() error {
	_, err := q.sendControlRequest(map[string]any{
		"subtype": "interrupt",
	}, 10*time.Second)
	return err
}

// SetPermissionMode changes the permission mode mid-session
func (q *Query) SetPermissionMode(mode PermissionMode) error {
	_, err := q.sendControlRequest(map[string]any{
		"subtype": "set_permission_mode",
		"mode":    string(mode),
	}, 10*time.Second)
	return err
}

// SetModel changes the AI model mid-session
func (q *Query) SetModel(model string) error {
	request := map[string]any{
		"subtype": "set_model",
	}
	if model != "" {
		request["model"] = model
	}
	_, err := q.sendControlRequest(request, 10*time.Second)
	return err
}

// RewindFiles reverts tracked files to their state at a specific user message
func (q *Query) RewindFiles(userMessageID string) error {
	_, err := q.sendControlRequest(map[string]any{
		"subtype":         "rewind_files",
		"user_message_id": userMessageID,
	}, 30*time.Second)
	return err
}

// SendUserMessage sends a user message to Claude.
// When uuid is provided, it is included in the JSON payload so Claude CLI
// uses the same UUID in its JSONL transcript (fixing reconnect dedup).
func (q *Query) SendUserMessage(content string, sessionID string, uuid string) error {
	if sessionID == "" {
		sessionID = "default"
	}

	message := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": content,
		},
		"parent_tool_use_id": nil,
		"session_id":         sessionID,
	}
	if uuid != "" {
		message["uuid"] = uuid
	}

	msgJSON, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("failed to marshal user message: %w", err)
	}

	return q.transport.Write(string(msgJSON) + "\n")
}

// SendToolResult sends a tool result back to Claude.
// This is used for tools like AskUserQuestion that require user input.
// The toolUseID must match the id from the tool_use block.
func (q *Query) SendToolResult(toolUseID string, content string, sessionID string) error {
	if sessionID == "" {
		sessionID = "default"
	}

	message := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role": "user",
			"content": []map[string]any{
				{
					"type":        "tool_result",
					"tool_use_id": toolUseID,
					"content":     content,
				},
			},
		},
		"parent_tool_use_id": nil,
		"session_id":         sessionID,
	}

	msgJSON, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("failed to marshal tool result: %w", err)
	}

	log.Debug().
		Str("toolUseId", toolUseID).
		Str("content", content).
		Msg("sending tool_result to Claude CLI")

	return q.transport.Write(string(msgJSON) + "\n")
}

// Messages returns a channel for receiving messages as map[string]any.
// This matches Python SDK's query.receive_messages() -> dict[str, Any].
func (q *Query) Messages() <-chan map[string]any {
	return q.messages
}

// GetServerInfo returns the initialization result
func (q *Query) GetServerInfo() *ServerInfo {
	return q.initializationResult
}

// WaitForFirstResult waits until the first result message is received
func (q *Query) WaitForFirstResult(timeout time.Duration) error {
	select {
	case <-q.firstResultEvent:
		return nil
	case <-time.After(timeout):
		return ErrTimeout
	case <-q.ctx.Done():
		return q.ctx.Err()
	}
}

// Close shuts down the query and transport
func (q *Query) Close() error {
	q.closedMu.Lock()
	if q.closed {
		q.closedMu.Unlock()
		return nil
	}
	q.closed = true
	q.closedMu.Unlock()

	if q.cancel != nil {
		q.cancel()
	}

	// Wait for goroutines with timeout (readers may be blocked on I/O)
	done := make(chan struct{})
	go func() {
		q.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		log.Debug().Msg("query goroutines finished cleanly")
	case <-time.After(2 * time.Second):
		log.Warn().Msg("query goroutines did not finish in time")
	}

	return q.transport.Close()
}
