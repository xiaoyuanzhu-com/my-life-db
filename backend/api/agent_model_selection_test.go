package api

import (
	"context"
	"errors"
	"strings"
	"testing"

	acp "github.com/coder/acp-go-sdk"
	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
)

type modelSelectionSession struct {
	agentsdk.Session
	selectionErr error
	selected     string
	closed       bool
}

func (s *modelSelectionSession) SetModel(_ context.Context, model string) ([]acp.SessionConfigOption, error) {
	s.selected = model
	return nil, s.selectionErr
}
func (s *modelSelectionSession) Close() error { s.closed = true; return nil }

func TestRequiredModelRejectsWithoutLeavingFallbackSession(t *testing.T) {
	rejected := errors.New("unknown model")
	sess := &modelSelectionSession{selectionErr: rejected}
	_, err := setRequiredModel(context.Background(), sess, "gpt-6-sol")
	if !errors.Is(err, rejected) || !strings.Contains(err.Error(), "gpt-6-sol") {
		t.Fatalf("expected actionable model error, got %v", err)
	}
	if !sess.closed {
		t.Fatal("rejected selection left fallback session alive")
	}
}

func TestRequiredModelKeepsAcceptedSession(t *testing.T) {
	sess := &modelSelectionSession{}
	if _, err := setRequiredModel(context.Background(), sess, "gpt-6-sol"); err != nil {
		t.Fatal(err)
	}
	if sess.closed || sess.selected != "gpt-6-sol" {
		t.Fatalf("accepted selection: %+v", sess)
	}
}
