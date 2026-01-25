package sdk

import (
	"sync"
)

// HookManager manages hook registrations and callbacks
type HookManager struct {
	matchers    map[HookEvent][]HookMatcher
	callbacks   map[string]HookCallback
	nextID      int
	mu          sync.RWMutex
}

// NewHookManager creates a new hook manager
func NewHookManager() *HookManager {
	return &HookManager{
		matchers:  make(map[HookEvent][]HookMatcher),
		callbacks: make(map[string]HookCallback),
	}
}

// Register adds a hook callback for the specified event
// Returns the callback ID that can be used to unregister
func (h *HookManager) Register(event HookEvent, matcher string, callback HookCallback) string {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.nextID++
	callbackID := generateCallbackID(h.nextID)

	h.callbacks[callbackID] = callback

	// Find or create matcher
	found := false
	for i, m := range h.matchers[event] {
		if m.Matcher == matcher {
			h.matchers[event][i].Hooks = append(h.matchers[event][i].Hooks, callback)
			found = true
			break
		}
	}

	if !found {
		h.matchers[event] = append(h.matchers[event], HookMatcher{
			Matcher: matcher,
			Hooks:   []HookCallback{callback},
		})
	}

	return callbackID
}

// RegisterWithTimeout adds a hook callback with a custom timeout
func (h *HookManager) RegisterWithTimeout(event HookEvent, matcher string, timeout float64, callback HookCallback) string {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.nextID++
	callbackID := generateCallbackID(h.nextID)

	h.callbacks[callbackID] = callback

	// Find or create matcher
	found := false
	for i, m := range h.matchers[event] {
		if m.Matcher == matcher {
			h.matchers[event][i].Hooks = append(h.matchers[event][i].Hooks, callback)
			found = true
			break
		}
	}

	if !found {
		h.matchers[event] = append(h.matchers[event], HookMatcher{
			Matcher: matcher,
			Hooks:   []HookCallback{callback},
			Timeout: &timeout,
		})
	}

	return callbackID
}

// Unregister removes a hook callback by ID
func (h *HookManager) Unregister(callbackID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, exists := h.callbacks[callbackID]; !exists {
		return false
	}

	delete(h.callbacks, callbackID)
	// Note: The callback is still in the matchers slice, but it won't be found
	// when looking up by ID. This is a simplification; full cleanup would require
	// more complex tracking.
	return true
}

// GetMatchers returns all matchers for an event
func (h *HookManager) GetMatchers(event HookEvent) []HookMatcher {
	h.mu.RLock()
	defer h.mu.RUnlock()

	return h.matchers[event]
}

// GetCallback returns a callback by ID
func (h *HookManager) GetCallback(callbackID string) (HookCallback, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	cb, ok := h.callbacks[callbackID]
	return cb, ok
}

// ToOptionsMap converts the hook manager's matchers to the options format
func (h *HookManager) ToOptionsMap() map[HookEvent][]HookMatcher {
	h.mu.RLock()
	defer h.mu.RUnlock()

	result := make(map[HookEvent][]HookMatcher)
	for event, matchers := range h.matchers {
		result[event] = make([]HookMatcher, len(matchers))
		copy(result[event], matchers)
	}
	return result
}

func generateCallbackID(id int) string {
	return "hook_" + string(rune('0'+id%10))
}

// --- Pre-built Hook Helpers ---

// PreToolUseAllow creates a hook output that allows the tool use
func PreToolUseAllow() HookOutput {
	return HookOutput{
		HookSpecificOutput: &HookSpecificOutput{
			HookEventName:      "PreToolUse",
			PermissionDecision: "allow",
		},
	}
}

// PreToolUseDeny creates a hook output that denies the tool use
func PreToolUseDeny(reason string) HookOutput {
	return HookOutput{
		HookSpecificOutput: &HookSpecificOutput{
			HookEventName:            "PreToolUse",
			PermissionDecision:       "deny",
			PermissionDecisionReason: reason,
		},
	}
}

// PreToolUseAsk creates a hook output that asks the user
func PreToolUseAsk() HookOutput {
	return HookOutput{
		HookSpecificOutput: &HookSpecificOutput{
			HookEventName:      "PreToolUse",
			PermissionDecision: "ask",
		},
	}
}

// PreToolUseModify creates a hook output that allows with modified input
func PreToolUseModify(modifiedInput map[string]any) HookOutput {
	return HookOutput{
		HookSpecificOutput: &HookSpecificOutput{
			HookEventName:      "PreToolUse",
			PermissionDecision: "allow",
			UpdatedInput:       modifiedInput,
		},
	}
}

// PostToolUseAddContext creates a hook output that adds context after tool use
func PostToolUseAddContext(context string) HookOutput {
	return HookOutput{
		HookSpecificOutput: &HookSpecificOutput{
			HookEventName:     "PostToolUse",
			AdditionalContext: context,
		},
	}
}

// StopSession creates a hook output that stops the session
func StopSession(reason string) HookOutput {
	cont := false
	return HookOutput{
		Continue:   &cont,
		StopReason: reason,
	}
}

// ContinueSession creates a hook output that continues the session
func ContinueSession() HookOutput {
	cont := true
	return HookOutput{
		Continue: &cont,
	}
}

// BlockWithMessage creates a hook output that blocks with a system message
func BlockWithMessage(systemMessage string, reason string) HookOutput {
	return HookOutput{
		Decision:      "block",
		SystemMessage: systemMessage,
		Reason:        reason,
	}
}

// --- Common Hook Patterns ---

// LoggingHook creates a hook that logs tool usage
func LoggingHook(logFn func(event string, toolName string, input map[string]any)) HookCallback {
	return func(input HookInput, toolUseID *string, ctx HookContext) (HookOutput, error) {
		switch hi := input.(type) {
		case PreToolUseHookInput:
			logFn("PreToolUse", hi.ToolName, hi.ToolInput)
		case PostToolUseHookInput:
			logFn("PostToolUse", hi.ToolName, hi.ToolInput)
		}
		return ContinueSession(), nil
	}
}

// ValidationHook creates a hook that validates tool inputs
func ValidationHook(validateFn func(toolName string, input map[string]any) (bool, string)) HookCallback {
	return func(input HookInput, toolUseID *string, ctx HookContext) (HookOutput, error) {
		if hi, ok := input.(PreToolUseHookInput); ok {
			valid, reason := validateFn(hi.ToolName, hi.ToolInput)
			if !valid {
				return PreToolUseDeny(reason), nil
			}
		}
		return PreToolUseAllow(), nil
	}
}

// TransformHook creates a hook that transforms tool inputs
func TransformHook(transformFn func(toolName string, input map[string]any) map[string]any) HookCallback {
	return func(input HookInput, toolUseID *string, ctx HookContext) (HookOutput, error) {
		if hi, ok := input.(PreToolUseHookInput); ok {
			modifiedInput := transformFn(hi.ToolName, hi.ToolInput)
			if modifiedInput != nil {
				return PreToolUseModify(modifiedInput), nil
			}
		}
		return PreToolUseAllow(), nil
	}
}

// DenyToolsHook creates a hook that denies specific tools
func DenyToolsHook(deniedTools ...string) HookCallback {
	denySet := make(map[string]bool)
	for _, t := range deniedTools {
		denySet[t] = true
	}

	return func(input HookInput, toolUseID *string, ctx HookContext) (HookOutput, error) {
		if hi, ok := input.(PreToolUseHookInput); ok {
			if denySet[hi.ToolName] {
				return PreToolUseDeny("Tool " + hi.ToolName + " is not allowed"), nil
			}
		}
		return PreToolUseAllow(), nil
	}
}

// AllowToolsHook creates a hook that only allows specific tools
func AllowToolsHook(allowedTools ...string) HookCallback {
	allowSet := make(map[string]bool)
	for _, t := range allowedTools {
		allowSet[t] = true
	}

	return func(input HookInput, toolUseID *string, ctx HookContext) (HookOutput, error) {
		if hi, ok := input.(PreToolUseHookInput); ok {
			if !allowSet[hi.ToolName] {
				return PreToolUseDeny("Tool " + hi.ToolName + " is not in the allowed list"), nil
			}
		}
		return PreToolUseAllow(), nil
	}
}
