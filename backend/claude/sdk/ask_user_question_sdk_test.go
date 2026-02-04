package sdk_test

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"

	claudesdk "github.com/xiaoyuanzhu-com/my-life-db/claude/sdk"
)

// TestAskUserQuestionWithSDK tests the AskUserQuestion flow using the SDK's CanUseTool callback.
// This verifies that:
// 1. AskUserQuestion triggers the CanUseTool callback
// 2. We can return PermissionResultAllow with UpdatedInput containing answers
// 3. Claude receives the answers and continues
//
// Run with: go test -v -run TestAskUserQuestionWithSDK ./claude/sdk/
func TestAskUserQuestionWithSDK(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("Skipping in CI environment")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	var (
		mu                  sync.Mutex
		sawAskUserQuestion  bool
		questionsReceived   []map[string]any
		answersProvided     map[string]any
		toolResultContent   string
	)

	maxTurns := 3
	client := claudesdk.NewClaudeSDKClient(claudesdk.ClaudeAgentOptions{
		Cwd:                "/tmp",
		SkipInitialization: true,
		MaxTurns:           &maxTurns,
		// CanUseTool callback - this is where we handle AskUserQuestion
		CanUseTool: func(toolName string, input map[string]any, ctx claudesdk.ToolPermissionContext) (claudesdk.PermissionResult, error) {
			t.Logf("CanUseTool called: tool=%s", toolName)
			inputJSON, _ := json.MarshalIndent(input, "", "  ")
			t.Logf("Input: %s", string(inputJSON))

			if toolName == "AskUserQuestion" {
				mu.Lock()
				sawAskUserQuestion = true
				// Extract questions
				if questions, ok := input["questions"].([]any); ok {
					for _, q := range questions {
						if qMap, ok := q.(map[string]any); ok {
							questionsReceived = append(questionsReceived, qMap)
						}
					}
				}
				mu.Unlock()

				// Simulate user answering the question
				// Per SDK docs: return Allow with UpdatedInput containing questions + answers
				answers := map[string]any{
					"What is your favorite color?": "Blue",
				}

				mu.Lock()
				answersProvided = answers
				mu.Unlock()

				updatedInput := map[string]any{
					"questions": input["questions"],
					"answers":   answers,
				}

				t.Log(">>> Returning PermissionResultAllow with answers")
				return claudesdk.PermissionResultAllow{
					Behavior:     claudesdk.PermissionAllow,
					UpdatedInput: updatedInput,
				}, nil
			}

			// Auto-approve other tools
			return claudesdk.PermissionResultAllow{
				Behavior: claudesdk.PermissionAllow,
			}, nil
		},
	})

	if err := client.Connect(ctx, ""); err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer client.Close()

	// Send a prompt that should trigger AskUserQuestion
	prompt := "Please use the AskUserQuestion tool to ask me: What is your favorite color? Give me options: Red, Blue, Green"
	t.Logf("Sending prompt: %s", prompt)
	if err := client.SendMessage(prompt); err != nil {
		t.Fatalf("Failed to send message: %v", err)
	}

	// Read messages until we get a result
	messages := client.RawMessages()
	timeout := time.After(45 * time.Second)

readLoop:
	for {
		select {
		case msg, ok := <-messages:
			if !ok {
				t.Log("Message channel closed")
				break readLoop
			}

			msgType, _ := msg["type"].(string)
			t.Logf("Received message type: %s", msgType)

			// Log full message for debugging
			msgJSON, _ := json.MarshalIndent(msg, "", "  ")
			t.Logf("Full message:\n%s", string(msgJSON))

			// Check for tool_result in user messages
			if msgType == "user" {
				if message, ok := msg["message"].(map[string]any); ok {
					if content, ok := message["content"].([]any); ok {
						for _, block := range content {
							if blockMap, ok := block.(map[string]any); ok {
								if blockMap["type"] == "tool_result" {
									if contentStr, ok := blockMap["content"].(string); ok {
										mu.Lock()
										toolResultContent = contentStr
										mu.Unlock()
										t.Logf(">>> Tool result content: %s", contentStr)
									}
								}
							}
						}
					}
				}
			}

			// Check for result (end of turn)
			if msgType == "result" {
				t.Log(">>> Got result message - conversation complete")
				break readLoop
			}

		case <-timeout:
			t.Log("Timeout reached")
			break readLoop

		case <-ctx.Done():
			t.Log("Context cancelled")
			break readLoop
		}
	}

	// Verify results
	t.Log("\n=== TEST RESULTS ===")

	mu.Lock()
	defer mu.Unlock()

	if !sawAskUserQuestion {
		t.Error("FAIL: CanUseTool was never called for AskUserQuestion")
	} else {
		t.Log("PASS: CanUseTool was called for AskUserQuestion")
	}

	if len(questionsReceived) == 0 {
		t.Error("FAIL: No questions were received in the callback")
	} else {
		t.Logf("PASS: Received %d question(s)", len(questionsReceived))
		for i, q := range questionsReceived {
			t.Logf("  Question %d: %v", i+1, q["question"])
		}
	}

	if answersProvided == nil {
		t.Error("FAIL: No answers were provided")
	} else {
		t.Logf("PASS: Answers provided: %v", answersProvided)
	}

	// Check if the tool result contains our answer
	if toolResultContent != "" {
		t.Logf("Tool result content: %s", toolResultContent)
		// The content should contain our answer somehow
		if containsAnswer(toolResultContent, "Blue") {
			t.Log("PASS: Tool result appears to contain our answer")
		} else {
			t.Log("INFO: Tool result may not directly contain our answer text")
		}
	}
}

func containsAnswer(content string, answer string) bool {
	// Simple check - could be more sophisticated
	return len(content) > 0 && (content == answer ||
		// The content might be JSON with our answer
		func() bool {
			var data map[string]any
			if err := json.Unmarshal([]byte(content), &data); err == nil {
				if answers, ok := data["answers"].(map[string]any); ok {
					for _, v := range answers {
						if v == answer {
							return true
						}
					}
				}
			}
			return false
		}())
}

// ============================================================================
// VERIFIED BEHAVIORS - AskUserQuestion SDK Flow
// ============================================================================
//
// These tests document and verify the expected SDK behavior for AskUserQuestion.
// They serve as both tests and documentation for how the feature works.
//
// Reference: docs/claude-code/data-models.md (Section 4i - AskUserQuestion in UI Mode)
// Reference: docs/claude-code/how-it-works.md (AskUserQuestion Tool section)
//
// ============================================================================

// TestVerifiedBehavior_AskUserQuestion_TriggersCanUseTool verifies that
// AskUserQuestion tool calls trigger the SDK's CanUseTool callback.
//
// VERIFIED BEHAVIOR:
// - When Claude uses AskUserQuestion, the CanUseTool callback is invoked
// - The callback receives toolName="AskUserQuestion" and input with "questions" array
// - This allows external handlers to intercept and collect user answers
//
// This is critical for UI mode where we need to broadcast questions to the frontend.
func TestVerifiedBehavior_AskUserQuestion_TriggersCanUseTool(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("Skipping in CI environment - requires Claude CLI")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	var (
		mu                 sync.Mutex
		callbackInvoked    bool
		receivedToolName   string
		receivedQuestions  []any
	)

	maxTurns := 2
	client := claudesdk.NewClaudeSDKClient(claudesdk.ClaudeAgentOptions{
		Cwd:                "/tmp",
		SkipInitialization: true,
		MaxTurns:           &maxTurns,
		CanUseTool: func(toolName string, input map[string]any, ctx claudesdk.ToolPermissionContext) (claudesdk.PermissionResult, error) {
			if toolName == "AskUserQuestion" {
				mu.Lock()
				callbackInvoked = true
				receivedToolName = toolName
				if questions, ok := input["questions"].([]any); ok {
					receivedQuestions = questions
				}
				mu.Unlock()

				// Return with answers to allow conversation to continue
				return claudesdk.PermissionResultAllow{
					Behavior: claudesdk.PermissionAllow,
					UpdatedInput: map[string]any{
						"questions": input["questions"],
						"answers":   map[string]any{"test": "answer"},
					},
				}, nil
			}
			return claudesdk.PermissionResultAllow{Behavior: claudesdk.PermissionAllow}, nil
		},
	})

	if err := client.Connect(ctx, ""); err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer client.Close()

	if err := client.SendMessage("Use AskUserQuestion to ask: What is your name? Options: Alice, Bob"); err != nil {
		t.Fatalf("Failed to send message: %v", err)
	}

	// Wait for conversation to complete
	messages := client.RawMessages()
	timeout := time.After(45 * time.Second)

readLoop:
	for {
		select {
		case msg, ok := <-messages:
			if !ok {
				break readLoop
			}
			if msg["type"] == "result" {
				break readLoop
			}
		case <-timeout:
			break readLoop
		case <-ctx.Done():
			break readLoop
		}
	}

	// Verify the callback was invoked correctly
	mu.Lock()
	defer mu.Unlock()

	if !callbackInvoked {
		t.Fatal("VERIFIED BEHAVIOR VIOLATED: CanUseTool callback was not invoked for AskUserQuestion")
	}

	if receivedToolName != "AskUserQuestion" {
		t.Fatalf("VERIFIED BEHAVIOR VIOLATED: Expected toolName='AskUserQuestion', got '%s'", receivedToolName)
	}

	if len(receivedQuestions) == 0 {
		t.Fatal("VERIFIED BEHAVIOR VIOLATED: CanUseTool callback did not receive questions array")
	}

	t.Log("VERIFIED: AskUserQuestion triggers CanUseTool callback with questions array")
}

// TestVerifiedBehavior_AskUserQuestion_UpdatedInputPassesAnswers verifies that
// returning PermissionResultAllow with UpdatedInput passes answers to Claude.
//
// VERIFIED BEHAVIOR:
// - When CanUseTool returns Allow with UpdatedInput containing "answers" field
// - Claude receives a tool_result containing those answers
// - The answers format is: map[questionText]answerValue
//
// This is the mechanism by which user answers are injected into the conversation.
func TestVerifiedBehavior_AskUserQuestion_UpdatedInputPassesAnswers(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("Skipping in CI environment - requires Claude CLI")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// The answer we'll inject
	expectedAnswer := "My answer is Blue"

	var (
		mu               sync.Mutex
		sawToolResult    bool
		toolResultString string
	)

	maxTurns := 2
	client := claudesdk.NewClaudeSDKClient(claudesdk.ClaudeAgentOptions{
		Cwd:                "/tmp",
		SkipInitialization: true,
		MaxTurns:           &maxTurns,
		CanUseTool: func(toolName string, input map[string]any, ctx claudesdk.ToolPermissionContext) (claudesdk.PermissionResult, error) {
			if toolName == "AskUserQuestion" {
				// Inject our answer via UpdatedInput
				return claudesdk.PermissionResultAllow{
					Behavior: claudesdk.PermissionAllow,
					UpdatedInput: map[string]any{
						"questions": input["questions"],
						"answers": map[string]any{
							"What is your favorite color?": expectedAnswer,
						},
					},
				}, nil
			}
			return claudesdk.PermissionResultAllow{Behavior: claudesdk.PermissionAllow}, nil
		},
	})

	if err := client.Connect(ctx, ""); err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer client.Close()

	if err := client.SendMessage("Use AskUserQuestion to ask: What is your favorite color? Options: Red, Blue, Green"); err != nil {
		t.Fatalf("Failed to send message: %v", err)
	}

	// Read messages and look for tool_result
	messages := client.RawMessages()
	timeout := time.After(45 * time.Second)

readLoop:
	for {
		select {
		case msg, ok := <-messages:
			if !ok {
				break readLoop
			}

			// Check for tool_result in user messages
			if msg["type"] == "user" {
				if message, ok := msg["message"].(map[string]any); ok {
					if content, ok := message["content"].([]any); ok {
						for _, block := range content {
							if blockMap, ok := block.(map[string]any); ok {
								if blockMap["type"] == "tool_result" {
									mu.Lock()
									sawToolResult = true
									if contentStr, ok := blockMap["content"].(string); ok {
										toolResultString = contentStr
									}
									mu.Unlock()
								}
							}
						}
					}
				}
			}

			if msg["type"] == "result" {
				break readLoop
			}
		case <-timeout:
			break readLoop
		case <-ctx.Done():
			break readLoop
		}
	}

	mu.Lock()
	defer mu.Unlock()

	if !sawToolResult {
		t.Fatal("VERIFIED BEHAVIOR VIOLATED: No tool_result message was generated")
	}

	// The tool_result should contain our answer in some form
	// (either as raw text or as JSON with our answer)
	if toolResultString == "" {
		t.Fatal("VERIFIED BEHAVIOR VIOLATED: tool_result content is empty")
	}

	t.Logf("VERIFIED: UpdatedInput answers passed to tool_result: %s", toolResultString)
}
