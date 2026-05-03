package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/connect"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
)

// These are pure-logic unit tests for the parts of connect_middleware.go
// that don't need a full server (no DB, no auth, no Connect store).
//
// Wider integration coverage of the scope-gated /api/data/* routes is
// expected to land in a separate test file once the api package gets a
// reusable test harness. The Python reference client at
// examples/connect-python/ exercises the full live flow end-to-end.

func init() {
	gin.SetMode(gin.TestMode)
}

// makeScopes builds a normalized ScopeSet from "files.read:/foo files.write:/"-style strings.
func makeScopes(t *testing.T, raw string) connect.ScopeSet {
	t.Helper()
	ss, err := connect.ParseScopes(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return ss
}

func TestPathFromBody(t *testing.T) {
	tests := []struct {
		name string
		body string
		key  string
		want string
	}{
		{"present-string", `{"parent":"notes/2026"}`, "parent", "notes/2026"},
		{"absent-key", `{"name":"foo"}`, "parent", ""},
		{"empty-string", `{"parent":""}`, "parent", ""},
		{"non-string", `{"parent":123}`, "parent", ""},
		{"invalid-json", `not-json`, "parent", ""},
		{"empty-body", ``, "parent", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Set(bufferedBodyKey, []byte(tc.body))
			got := PathFromBody(c, tc.key)
			if got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestPathFromBody_NoBuffer(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	if got := PathFromBody(c, "parent"); got != "" {
		t.Fatalf("unbuffered should return empty, got %q", got)
	}
}

func TestPathExtractors(t *testing.T) {
	t.Run("param-with-leading-slash", func(t *testing.T) {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Params = gin.Params{{Key: "path", Value: "/notes/2026/foo.md"}}
		if got := pathFromParam(c); got != "notes/2026/foo.md" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("param-empty", func(t *testing.T) {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		if got := pathFromParam(c); got != "" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("query", func(t *testing.T) {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request, _ = http.NewRequest("GET", "/x?path=notes/foo.md", nil)
		if got := pathFromQuery(c); got != "notes/foo.md" {
			t.Fatalf("got %q", got)
		}
	})
}

func TestEventVisibleToScope(t *testing.T) {
	cases := []struct {
		name   string
		scopes connect.ScopeSet
		event  notifications.Event
		want   bool
	}{
		{
			name:   "owner-session-sees-everything",
			scopes: nil,
			event:  notifications.Event{Type: "library.changed", Path: "/journal/secret.md"},
			want:   true,
		},
		{
			name:   "connect-no-path-event-passes",
			scopes: makeScopes(t, "files.read:/notes"),
			event:  notifications.Event{Type: "system.heartbeat"},
			want:   true,
		},
		{
			name:   "connect-covered-path",
			scopes: makeScopes(t, "files.read:/notes"),
			event:  notifications.Event{Type: "library.changed", Path: "/notes/2026/foo.md"},
			want:   true,
		},
		{
			name:   "connect-uncovered-path",
			scopes: makeScopes(t, "files.read:/notes"),
			event:  notifications.Event{Type: "library.changed", Path: "/journal/secret.md"},
			want:   false,
		},
		{
			name:   "connect-root-grant-covers-everything",
			scopes: makeScopes(t, "files.read:/"),
			event:  notifications.Event{Type: "library.changed", Path: "/journal/x.md"},
			want:   true,
		},
		{
			name:   "connect-write-only-cannot-read-events",
			scopes: makeScopes(t, "files.write:/notes"),
			event:  notifications.Event{Type: "library.changed", Path: "/notes/foo.md"},
			want:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := eventVisibleToScope(tc.event, tc.scopes)
			if got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestExtractBearer(t *testing.T) {
	t.Run("authorization-header", func(t *testing.T) {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request, _ = http.NewRequest("GET", "/x", nil)
		c.Request.Header.Set("Authorization", "Bearer abc123")
		if got := extractBearer(c); got != "abc123" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("query-fallback", func(t *testing.T) {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request, _ = http.NewRequest("GET", "/x?connect_access_token=xyz", nil)
		if got := extractBearer(c); got != "xyz" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("none", func(t *testing.T) {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request, _ = http.NewRequest("GET", "/x", nil)
		if got := extractBearer(c); got != "" {
			t.Fatalf("got %q", got)
		}
	})
}

// TestBufferJSONBody_RoundTrip verifies that a handler downstream of
// BufferJSONBody can still parse the body, and that PathFromBody can read
// the same buffer in parallel.
func TestBufferJSONBody_RoundTrip(t *testing.T) {
	h := &Handlers{} // BufferJSONBody doesn't reference any Server fields
	mw := h.BufferJSONBody()

	type req struct {
		Parent string `json:"parent"`
		Name   string `json:"name"`
	}

	r := gin.New()
	r.POST("/test", mw, func(c *gin.Context) {
		// Two consumers of the body: first the scope helper, then the handler.
		gotPath := PathFromBody(c, "parent")
		var body req
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"err": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"viaBody": body.Parent, "viaPath": gotPath})
	})

	bodyBytes, _ := json.Marshal(req{Parent: "notes/2026", Name: "foo"})
	w := httptest.NewRecorder()
	rq := httptest.NewRequest("POST", "/test", bytes.NewReader(bodyBytes))
	rq.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, rq)

	if w.Code != http.StatusOK {
		t.Fatalf("status %d body=%s", w.Code, w.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got["viaBody"] != "notes/2026" || got["viaPath"] != "notes/2026" {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}
