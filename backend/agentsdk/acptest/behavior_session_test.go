//go:build acptest

package acptest

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

// TestACPSessionLoadWithinSameProcess tests session/load within a single agent
// process. This is the "happy path" — the session ID is still valid because
// the process hasn't restarted.
//
// Documents: does LoadSession replay history? What events fire during replay?
func TestACPSessionLoadWithinSameProcess(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// Step 1: Have a conversation with a memorable fact
	t.Log("=== Step 1: Initial conversation ===")
	_, events1 := h.Prompt(ctx, "Remember: the secret word is 'platypus'. Reply with 'Understood, I will remember platypus.'")
	text1 := AgentText(events1)
	t.Logf("Initial response: %q", truncate(text1, 200))

	originalSessionID := h.SessionID()
	t.Logf("Original session ID: %s", originalSessionID)

	// Step 2: Create a SECOND session on the same connection, then try to
	// load the original session back. This tests LoadSession within the
	// same agent process (no restart).
	t.Log("=== Step 2: Create second session ===")
	sess2, err := h.Conn().NewSession(ctx, acp.NewSessionRequest{
		Cwd:        t.TempDir(),
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		t.Fatalf("NewSession (second): %v", err)
	}
	t.Logf("Second session ID: %s", sess2.SessionId)

	// Step 3: Load the original session back
	t.Log("=== Step 3: Load original session ===")
	h.Client().resetEvents()

	loadResp, err := h.Conn().LoadSession(ctx, acp.LoadSessionRequest{
		SessionId:  originalSessionID,
		Cwd:        t.TempDir(),
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		t.Logf("FINDING: LoadSession within same process FAILED: %v", err)
		t.Log("This means session/load doesn't work even within the same process.")
		return
	}

	t.Logf("FINDING: LoadSession within same process SUCCEEDED")
	t.Logf("LoadSession response modes: %v", loadResp.Modes != nil)

	// Check what events were replayed
	replayEvents := h.Client().getEvents()
	t.Logf("Events replayed during LoadSession: %d", len(replayEvents))

	typeCounts := map[string]int{}
	for _, e := range replayEvents {
		typeCounts[e.Type]++
	}
	for typ, count := range typeCounts {
		t.Logf("  %s: %d", typ, count)
	}

	// Check if user messages are replayed
	userMsgs := Events(replayEvents, "user_message")
	t.Logf("User messages replayed: %d", len(userMsgs))

	// Check if agent messages are replayed
	agentMsgs := Events(replayEvents, "agent_message")
	t.Logf("Agent messages replayed: %d", len(agentMsgs))

	replayedText := AgentText(replayEvents)
	if strings.Contains(strings.ToLower(replayedText), "platypus") {
		t.Log("FINDING: Replayed agent text contains 'platypus' — history is faithfully replayed")
	} else {
		t.Logf("FINDING: Replayed agent text does NOT contain 'platypus': %q", truncate(replayedText, 200))
	}

	if len(replayEvents) > 0 {
		t.Log("FINDING: LoadSession replays conversation history as SessionUpdate notifications")
	} else {
		t.Log("FINDING: LoadSession does NOT replay history (empty events)")
	}
}

// TestACPSessionLoadAcrossProcessRestart tests session/load after killing
// the agent process and spawning a new one.
//
// Documents: is session persistence across process restarts supported?
// Previous finding: LoadSession fails with -32002 "Resource not found".
// This test re-verifies and captures the exact error.
func TestACPSessionLoadAcrossProcessRestart(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// Step 1: Have a conversation
	t.Log("=== Step 1: Initial conversation ===")
	h.Prompt(ctx, "Remember: the secret word is 'elephant'. Reply with 'Understood.'")

	sessionID := h.SessionID()
	t.Logf("Session ID to resume: %s", sessionID)

	// Step 2: Kill the agent process
	t.Log("=== Step 2: Kill agent process ===")
	h.Close()

	// Step 3: Spawn a new agent process and try to load the session
	t.Log("=== Step 3: New process, attempt LoadSession ===")
	h2 := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))
	h2.Client().resetEvents()

	loadResp, err := h2.Conn().LoadSession(ctx, acp.LoadSessionRequest{
		SessionId:  sessionID,
		Cwd:        t.TempDir(),
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		t.Logf("FINDING: LoadSession across process restart FAILED (expected): %v", err)

		// Try to extract JSON-RPC error details
		errStr := err.Error()
		if strings.Contains(errStr, "-32002") {
			t.Log("FINDING: Error code -32002 (Resource not found) — session IDs are process-scoped")
		}
		t.Log("CONCLUSION: session/load cannot restore sessions across process restarts")
		t.Log("NOTE: The ACP Go SDK v0.6.3 does NOT expose session/resume, session/list, or session/fork.")
		t.Log("      These unstable methods from the spec are not yet implemented in the SDK.")
		return
	}

	// If we get here, it actually worked (unexpected but great!)
	t.Logf("FINDING: LoadSession across process restart SUCCEEDED (unexpected!)")
	t.Logf("Response: %+v", loadResp)

	replayEvents := h2.Client().getEvents()
	t.Logf("Replayed events: %d", len(replayEvents))
}

// TestACPSessionLoadContextRetention tests whether a loaded session retains
// conversational context — i.e., can the agent recall facts from before
// the load?
//
// This only runs if within-process LoadSession succeeds.
func TestACPSessionLoadContextRetention(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(4*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// Step 1: Tell the agent a fact
	t.Log("=== Step 1: Tell agent a fact ===")
	h.Prompt(ctx, "Remember: my favorite color is 'cerulean'. Reply with 'Noted.'")

	originalSessionID := h.SessionID()

	// Step 2: Create a new session (switch away)
	t.Log("=== Step 2: Switch to new session ===")
	_, err := h.Conn().NewSession(ctx, acp.NewSessionRequest{
		Cwd:        t.TempDir(),
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}

	// Step 3: Load back the original session
	t.Log("=== Step 3: Load original session ===")
	_, err = h.Conn().LoadSession(ctx, acp.LoadSessionRequest{
		SessionId:  originalSessionID,
		Cwd:        t.TempDir(),
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		t.Skipf("LoadSession failed — cannot test context retention: %v", err)
	}

	// Step 4: Ask the agent to recall the fact
	t.Log("=== Step 4: Ask agent to recall ===")
	h.Client().resetEvents()

	// Override session ID for prompting on the loaded session
	origSessID := h.sessionID
	h.sessionID = originalSessionID
	defer func() { h.sessionID = origSessID }()

	_, events := h.Prompt(ctx, "What is my favorite color? Reply with just the color name.")
	text := AgentText(events)
	t.Logf("Agent recall response: %q", text)

	if strings.Contains(strings.ToLower(text), "cerulean") {
		t.Log("FINDING: Agent successfully recalled context after LoadSession — context is retained")
	} else {
		t.Logf("FINDING: Agent did NOT recall 'cerulean' — context may not be retained after LoadSession")
	}
}

// TestACPAskUserQuestionViaToolCall tests how Claude Code's AskUserQuestion
// tool surfaces through ACP.
//
// In the old Claude Code SDK, AskUserQuestion was a special control_request.
// In ACP, there's no dedicated "ask user" method. We need to discover how
// the agent exposes this:
//   - As a tool_call event with a recognizable title/kind?
//   - As a RequestPermission callback with question data in RawInput?
//   - As plain agent text (just asking in the message)?
//
// This test prompts the agent in a way that should trigger AskUserQuestion.
func TestACPAskUserQuestionViaToolCall(t *testing.T) {
	// Don't auto-approve — we need to see permission requests
	h := NewHarness(t, WithTimeout(4*time.Minute))
	h.Client().autoApprove = false

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// Use a goroutine to handle permission requests — approve everything
	// but log the details for analysis
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case evt := <-h.Client().permissionChan:
				t.Logf("[async permission] tool=%s", evt.request.ToolCall.ToolCallId)
				// Approve it
				for _, opt := range evt.request.Options {
					if opt.Kind == acp.PermissionOptionKindAllowOnce {
						evt.response <- acp.RequestPermissionResponse{
							Outcome: acp.NewRequestPermissionOutcomeSelected(opt.OptionId),
						}
						break
					}
				}
			}
		}
	}()

	// Enable auto-approve so the harness handles permissions normally
	h.Client().autoApprove = true

	// Prompt that should trigger AskUserQuestion:
	// The agent should realize it needs clarification and use AskUserQuestion
	_, events := h.Prompt(ctx, `I want you to use the AskUserQuestion tool (or equivalent) to ask me a question. Specifically, ask me "What programming language do you prefer?" — Do NOT just type the question as text. Use the actual AskUserQuestion tool if available.`)

	// Analyze what happened
	t.Log("=== Analysis of AskUserQuestion behavior ===")

	// Check for tool calls — AskUserQuestion might appear as one
	toolCalls := ToolCalls(events)
	t.Logf("Tool calls: %d", len(toolCalls))

	askUserFound := false
	for i, tc := range toolCalls {
		title := tc.ToolCall.Title
		kind := string(tc.ToolCall.Kind)
		t.Logf("  Tool[%d]: id=%s title=%q kind=%s status=%s",
			i, tc.ToolCall.ToolCallId, title, kind, tc.ToolCall.Status)

		if tc.ToolCall.RawInput != nil {
			raw, _ := json.Marshal(tc.ToolCall.RawInput)
			t.Logf("    RawInput: %s", truncate(string(raw), 300))
		}

		// Check if this looks like AskUserQuestion
		titleLower := strings.ToLower(tc.ToolCall.Title)
		if strings.Contains(titleLower, "ask") || strings.Contains(titleLower, "question") || strings.Contains(titleLower, "user") {
			askUserFound = true
			t.Logf("  >>> FOUND: Tool call that looks like AskUserQuestion: %q", title)
		}
	}

	// Check permissions — might surface as a permission request
	perms := Permissions(events)
	t.Logf("Permission requests: %d", len(perms))

	for i, p := range perms {
		title := "<nil>"
		if p.Permission.ToolCall.Title != nil {
			title = *p.Permission.ToolCall.Title
		}
		t.Logf("  Permission[%d]: title=%q options=%d", i, title, len(p.Permission.Options))

		if p.Permission.ToolCall.RawInput != nil {
			raw, _ := json.Marshal(p.Permission.ToolCall.RawInput)
			t.Logf("    RawInput: %s", truncate(string(raw), 300))

			// Check if the raw input contains question-like data
			rawStr := strings.ToLower(string(raw))
			if strings.Contains(rawStr, "question") || strings.Contains(rawStr, "ask") {
				askUserFound = true
				t.Logf("  >>> FOUND: Permission request that contains question data")
			}
		}
	}

	// Check agent text — maybe it just asks in the message
	text := AgentText(events)
	t.Logf("Agent text: %q", truncate(text, 300))

	if askUserFound {
		t.Log("FINDING: AskUserQuestion surfaces through ACP as a tool call or permission request")
	} else if strings.Contains(strings.ToLower(text), "programming language") {
		t.Log("FINDING: Agent asked the question as plain text, NOT via AskUserQuestion tool")
		t.Log("         This means AskUserQuestion may not be available through ACP,")
		t.Log("         or the agent chose not to use it.")
	} else {
		t.Log("FINDING: Agent did not ask the question at all — unclear behavior")
	}
}

// TestACPAskUserQuestionNaturalTrigger tries a more natural scenario that
// would trigger AskUserQuestion — an ambiguous request where the agent
// genuinely needs clarification.
//
// This is a more realistic test than explicitly asking the agent to use the tool.
func TestACPAskUserQuestionNaturalTrigger(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(4*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// An ambiguous request that should make the agent want to ask for clarification
	_, events := h.Prompt(ctx, `Create a new file for me. (Don't assume any filename or content — you MUST ask me what to name it and what to put in it before creating anything. Use the AskUserQuestion tool to ask me.)`)

	t.Log("=== Analysis of natural AskUserQuestion trigger ===")

	// Catalog ALL events
	typeCounts := map[string]int{}
	for _, e := range events {
		typeCounts[e.Type]++
	}
	t.Logf("Event type counts:")
	for typ, count := range typeCounts {
		t.Logf("  %s: %d", typ, count)
	}

	// Check tool calls
	toolCalls := ToolCalls(events)
	for i, tc := range toolCalls {
		t.Logf("Tool[%d]: title=%q id=%s", i, tc.ToolCall.Title, tc.ToolCall.ToolCallId)

		if tc.ToolCall.RawInput != nil {
			raw, _ := json.Marshal(tc.ToolCall.RawInput)
			t.Logf("  RawInput: %s", truncate(string(raw), 300))
		}
	}

	// Check permissions
	perms := Permissions(events)
	for i, p := range perms {
		title := "<nil>"
		if p.Permission.ToolCall.Title != nil {
			title = *p.Permission.ToolCall.Title
		}
		t.Logf("Permission[%d]: title=%q", i, title)
		if p.Permission.ToolCall.RawInput != nil {
			raw, _ := json.Marshal(p.Permission.ToolCall.RawInput)
			t.Logf("  RawInput: %s", truncate(string(raw), 300))
		}
	}

	// Check if the agent just asked as text
	text := AgentText(events)
	t.Logf("Agent text: %q", truncate(text, 500))

	// Determine the finding
	hasToolCallAsk := false
	for _, tc := range toolCalls {
		title := strings.ToLower(tc.ToolCall.Title)
		if strings.Contains(title, "ask") || strings.Contains(title, "question") {
			hasToolCallAsk = true
		}
		if tc.ToolCall.RawInput != nil {
			raw, _ := json.Marshal(tc.ToolCall.RawInput)
			rawStr := strings.ToLower(string(raw))
			if strings.Contains(rawStr, "question") {
				hasToolCallAsk = true
			}
		}
	}

	if hasToolCallAsk {
		t.Log("FINDING: AskUserQuestion IS available via ACP — surfaces as a tool call")
	} else if len(perms) > 0 {
		t.Log("FINDING: Agent used permission request flow instead of AskUserQuestion")
	} else {
		t.Log("FINDING: Agent asked as plain text — AskUserQuestion tool may not be exposed via ACP")
		t.Log("         The agent falls back to asking in the conversation text.")
	}
}

// TestACPSessionMultiTurnThenLoad combines multi-turn conversation with
// session load to verify that the full conversation history (not just the
// last turn) is preserved.
func TestACPSessionMultiTurnThenLoad(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(5*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	// Turn 1
	t.Log("=== Turn 1 ===")
	h.Prompt(ctx, "The first secret number is 42. Reply 'Got it.'")

	// Turn 2
	t.Log("=== Turn 2 ===")
	h.Prompt(ctx, "The second secret number is 73. Reply 'Got it.'")

	// Turn 3
	t.Log("=== Turn 3 ===")
	h.Prompt(ctx, "The third secret number is 99. Reply 'Got it.'")

	originalSessionID := h.SessionID()
	t.Logf("Session with 3 turns: %s", originalSessionID)

	// Switch to new session
	_, err := h.Conn().NewSession(ctx, acp.NewSessionRequest{
		Cwd:        t.TempDir(),
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}

	// Load back original
	h.Client().resetEvents()
	_, err = h.Conn().LoadSession(ctx, acp.LoadSessionRequest{
		SessionId:  originalSessionID,
		Cwd:        t.TempDir(),
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		t.Skipf("LoadSession failed — cannot test multi-turn retention: %v", err)
	}

	replayEvents := h.Client().getEvents()
	t.Logf("Total replayed events: %d", len(replayEvents))

	userMsgs := Events(replayEvents, "user_message")
	agentMsgs := Events(replayEvents, "agent_message")
	t.Logf("User messages replayed: %d", len(userMsgs))
	t.Logf("Agent messages replayed: %d", len(agentMsgs))

	replayedText := AgentText(replayEvents)
	has42 := strings.Contains(replayedText, "42")
	has73 := strings.Contains(replayedText, "73")
	has99 := strings.Contains(replayedText, "99")

	t.Logf("Replayed text contains 42: %v, 73: %v, 99: %v", has42, has73, has99)

	if has42 && has73 && has99 {
		t.Log("FINDING: LoadSession replays ALL turns of a multi-turn conversation")
	} else if has99 {
		t.Log("FINDING: LoadSession only replays the LAST turn")
	} else {
		t.Log("FINDING: LoadSession replay content is unclear — check replayed text above")
	}
}

// TestACPLoadHistoricalSessionFromDisk tests whether session/load can restore
// a historical session from Claude Code's JSONL files on disk.
//
// Claude Code persists sessions as JSONL files in ~/.claude/projects/<path>/.
// This test discovers a real historical session ID from disk and attempts to
// load it in a fresh claude-agent-acp process.
//
// This is critical for understanding session continuity after server restarts:
// if LoadSession can read JSONL files, we can resume conversations; if not,
// we need an alternative approach (e.g., claude --resume flag).
func TestACPLoadHistoricalSessionFromDisk(t *testing.T) {
	// Step 1: Discover a historical session ID from Claude's JSONL files
	t.Log("=== Step 1: Discover historical session from disk ===")

	homeDir, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("Cannot get home directory: %v", err)
	}

	projectsDir := homeDir + "/.claude/projects"
	projectEntries, err := os.ReadDir(projectsDir)
	if err != nil {
		t.Skipf("Cannot read Claude projects directory %s: %v", projectsDir, err)
	}

	var historicalSessionID string
	var originalCwd string // the ORIGINAL working directory, not the .claude/projects path
	var jsonlPath string

	for _, projEntry := range projectEntries {
		if !projEntry.IsDir() {
			continue
		}
		projPath := projectsDir + "/" + projEntry.Name()
		files, err := os.ReadDir(projPath)
		if err != nil {
			continue
		}
		for _, f := range files {
			name := f.Name()
			if strings.HasSuffix(name, ".jsonl") && !f.IsDir() {
				// Extract session ID from filename (remove .jsonl suffix)
				sid := strings.TrimSuffix(name, ".jsonl")
				// Basic UUID format check
				if len(sid) == 36 && strings.Count(sid, "-") == 4 {
					historicalSessionID = sid
					jsonlPath = projPath + "/" + name

					// Decode the project directory name back to the original cwd.
					// Claude encodes paths by replacing '/' with '-' and prepending '-'.
					// e.g., "-Users-iloahz-projects-MyLifeDB-my-life-db" → "/Users/iloahz/projects/MyLifeDB/my-life-db"
					encodedName := projEntry.Name()
					if strings.HasPrefix(encodedName, "-") {
						decoded := strings.ReplaceAll(encodedName, "-", "/")
						// Verify the decoded path exists on disk
						if info, err := os.Stat(decoded); err == nil && info.IsDir() {
							originalCwd = decoded
						}
					}
					break
				}
			}
		}
		if historicalSessionID != "" {
			break
		}
	}

	if historicalSessionID == "" {
		t.Skip("No historical Claude Code session JSONL files found on disk")
	}
	if originalCwd == "" {
		t.Skipf("Could not decode original cwd from project directory for session %s", historicalSessionID)
	}

	// Get file size for context
	info, _ := os.Stat(jsonlPath)
	t.Logf("Found historical session: %s", historicalSessionID)
	t.Logf("JSONL file: %s (%d bytes)", jsonlPath, info.Size())
	t.Logf("Original cwd: %s", originalCwd)

	// Count messages in the JSONL
	content, _ := os.ReadFile(jsonlPath)
	lineCount := strings.Count(string(content), "\n")
	t.Logf("JSONL lines: %d", lineCount)

	// Step 2: Spawn a fresh claude-agent-acp and try to load this session
	t.Log("=== Step 2: Fresh process, attempt LoadSession with historical ID ===")
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))
	h.Client().resetEvents()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Check if LoadSession capability is advertised
	t.Logf("Agent LoadSession capability: checking via LoadSession call")

	loadResp, err := h.Conn().LoadSession(ctx, acp.LoadSessionRequest{
		SessionId:  acp.SessionId(historicalSessionID),
		Cwd:        originalCwd,
		McpServers: []acp.McpServer{},
	})

	if err != nil {
		t.Logf("FINDING: LoadSession with historical session ID FAILED: %v", err)

		errStr := err.Error()
		if strings.Contains(errStr, "-32002") {
			t.Log("FINDING: Error -32002 (Resource not found) — claude-agent-acp does NOT read JSONL files")
			t.Log("         Historical sessions on disk are invisible to ACP session/load")
		} else if strings.Contains(errStr, "-32601") {
			t.Log("FINDING: Error -32601 (Method not found) — LoadSession not implemented")
		} else {
			t.Logf("FINDING: Unexpected error code — check error details above")
		}

		t.Log("")
		t.Log("CONCLUSION: Cannot resume historical sessions via ACP session/load.")
		t.Log("  Options for session continuity after restart:")
		t.Log("  1. Use 'claude --resume <id>' CLI flag (bypass ACP)")
		t.Log("  2. Re-inject conversation history into new session as context")
		t.Log("  3. Wait for ACP spec to add session persistence support")
		return
	}

	// If we get here, it worked!
	t.Log("FINDING: LoadSession with historical session ID SUCCEEDED!")
	t.Logf("Modes: %v, Models: %v", loadResp.Modes != nil, loadResp.Models != nil)

	// Wait for replay events
	time.Sleep(5 * time.Second)

	replayEvents := h.Client().getEvents()
	t.Logf("Replayed events: %d", len(replayEvents))

	typeCounts := map[string]int{}
	for _, e := range replayEvents {
		typeCounts[e.Type]++
	}
	for typ, count := range typeCounts {
		t.Logf("  %s: %d", typ, count)
	}

	userMsgs := Events(replayEvents, "user_message")
	agentMsgs := Events(replayEvents, "agent_message")
	t.Logf("User messages replayed: %d", len(userMsgs))
	t.Logf("Agent messages replayed: %d", len(agentMsgs))

	if len(replayEvents) > 0 {
		t.Log("FINDING: Historical session loaded AND replayed conversation history")
		t.Log("         This means session/load CAN restore sessions from JSONL files!")

		// Try sending a follow-up prompt
		t.Log("=== Step 3: Send follow-up prompt to verify context retention ===")
		h.Client().resetEvents()

		origSessID := h.sessionID
		h.sessionID = acp.SessionId(historicalSessionID)
		defer func() { h.sessionID = origSessID }()

		_, events := h.Prompt(ctx, "What was the first thing I asked you in this conversation? Reply briefly.")
		text := AgentText(events)
		t.Logf("Agent recall response: %q", truncate(text, 300))
		t.Log("FINDING: If the agent recalled context, historical session resume works end-to-end")
	} else {
		t.Log("FINDING: LoadSession succeeded but NO events replayed — session may be empty or replay is async")
	}
}

// TestACPLoadSessionCapability checks whether claude-agent-acp advertises
// the LoadSession capability during initialization.
func TestACPLoadSessionCapability(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(2*time.Minute))

	// The capability is in the InitializeResponse — we need to check it
	// Since the harness already called Initialize, we check by attempting LoadSession
	// with a known-invalid ID and inspecting the error code.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_, err := h.Conn().LoadSession(ctx, acp.LoadSessionRequest{
		SessionId:  "00000000-0000-0000-0000-000000000000",
		Cwd:        t.TempDir(),
		McpServers: []acp.McpServer{},
	})

	if err == nil {
		t.Log("FINDING: LoadSession with fake ID succeeded (unexpected)")
		return
	}

	errStr := err.Error()
	t.Logf("LoadSession error: %s", errStr)

	if strings.Contains(errStr, "-32601") {
		t.Log("FINDING: LoadSession returns -32601 (Method not found)")
		t.Log("         This means claude-agent-acp does NOT implement AgentLoader")
		t.Log("         The loadSession capability is NOT advertised")
	} else if strings.Contains(errStr, "-32002") {
		t.Log("FINDING: LoadSession returns -32002 (Resource not found)")
		t.Log("         This means claude-agent-acp DOES implement AgentLoader")
		t.Log("         The method exists but the session ID was not found")
	} else {
		t.Logf("FINDING: LoadSession returns unexpected error — capability status unclear")
	}
}
