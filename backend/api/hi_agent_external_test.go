package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/server"
)

func TestNewHiAgentExternalClientRequiresExplicitPair(t *testing.T) {
	if got := newHiAgentExternalClient(server.HiAgentConfig{}); got != nil {
		t.Fatal("empty hi-agent config must disable the bridge")
	}
	if got := newHiAgentExternalClient(server.HiAgentConfig{
		BaseURL: "http://127.0.0.1:12345",
	}); got != nil {
		t.Fatal("partial hi-agent config must disable the bridge")
	}
}

func TestHiAgentExternalLeaseRegisterAndRelease(t *testing.T) {
	const capability = "per-run-secret"
	var registrationAuth string
	var releaseAuth []string
	var releases int
	var gotBody map[string]string

	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/external-sessions" {
			registrationAuth = r.Header.Get("Authorization")
			if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
				t.Fatalf("decode registration: %v", err)
			}
			writeExternalRegistration(t, w, externalRegistrationResponse{
				Slug:       "general-weekly-report-friday",
				Owner:      "cognition",
				MCPURL:     "/mcp/custom-notification",
				Capability: capability,
				ExpiresAt:  time.Now().Add(10 * time.Minute),
			})
			return
		}
		if r.URL.Path == "/api/external-sessions/general-weekly-report-friday" {
			releases++
			releaseAuth = append(releaseAuth, r.Header.Get("Authorization"))
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.NotFound(w, r)
	}))
	defer stub.Close()

	client := newHiAgentExternalClient(server.HiAgentConfig{
		BaseURL:      stub.URL,
		SurfaceToken: "surface-secret",
	})
	lease, err := client.register(context.Background(), "weekly report", "weekly-report-friday")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if lease.owner != "cognition" {
		t.Fatalf("lease owner = %q, want cognition", lease.owner)
	}
	if lease.expiresAt.Before(time.Now()) {
		t.Fatalf("lease expiry = %s, want future", lease.expiresAt)
	}
	if registrationAuth != "Bearer surface-secret" {
		t.Fatalf("registration auth = %q", registrationAuth)
	}
	if gotBody["title"] != "weekly report" || gotBody["subject"] != "weekly-report-friday" {
		t.Fatalf("registration body = %#v", gotBody)
	}

	mcp := lease.mcpServer()
	if mcp.Http == nil || mcp.Http.Url != stub.URL+"/mcp/custom-notification" {
		t.Fatalf("unexpected MCP server: %#v", mcp)
	}
	if len(mcp.Http.Headers) != 1 || mcp.Http.Headers[0].Name != "Authorization" ||
		mcp.Http.Headers[0].Value != "Bearer "+capability {
		t.Fatalf("MCP capability was not scoped to the per-run server: %#v", mcp.Http.Headers)
	}
	if strings.Contains(mcp.Http.Url, capability) {
		t.Fatal("capability must not be placed in the MCP URL")
	}

	if err := lease.release(context.Background()); err != nil {
		t.Fatalf("release: %v", err)
	}
	if err := lease.release(context.Background()); err != nil {
		t.Fatalf("idempotent release: %v", err)
	}
	if releases != 2 {
		t.Fatalf("release calls = %d, want 2", releases)
	}
	for i, got := range releaseAuth {
		if got != "Bearer "+capability {
			t.Fatalf("release %d auth = %q", i+1, got)
		}
	}
}

func TestHiAgentExternalRegistrationResponseValidation(t *testing.T) {
	tests := []struct {
		name           string
		mutate         func(*externalRegistrationResponse, string)
		wantError      string
		wantBestEffort bool
	}{
		{
			name: "missing owner",
			mutate: func(response *externalRegistrationResponse, _ string) {
				response.Owner = ""
			},
			wantError:      "incomplete lease",
			wantBestEffort: true,
		},
		{
			name: "unexpected owner",
			mutate: func(response *externalRegistrationResponse, _ string) {
				response.Owner = "reaction"
			},
			wantError:      "unexpected owner",
			wantBestEffort: true,
		},
		{
			name: "self owned",
			mutate: func(response *externalRegistrationResponse, _ string) {
				response.Slug = "cognition"
			},
			wantError:      "self-owned",
			wantBestEffort: true,
		},
		{
			name: "expired",
			mutate: func(response *externalRegistrationResponse, _ string) {
				response.ExpiresAt = time.Now().Add(-time.Minute)
			},
			wantError:      "expired lease",
			wantBestEffort: true,
		},
		{
			name: "zero expiry",
			mutate: func(response *externalRegistrationResponse, _ string) {
				response.ExpiresAt = time.Time{}
			},
			wantError:      "incomplete lease",
			wantBestEffort: true,
		},
		{
			name: "cross origin MCP",
			mutate: func(response *externalRegistrationResponse, _ string) {
				response.MCPURL = "http://127.0.0.1:9/mcp/external"
			},
			wantError:      "configured loopback origin",
			wantBestEffort: true,
		},
		{
			name: "MCP query",
			mutate: func(response *externalRegistrationResponse, _ string) {
				response.MCPURL = "/mcp/external?capability=secret"
			},
			wantError:      "userinfo, query, or fragment",
			wantBestEffort: true,
		},
		{
			name: "MCP fragment",
			mutate: func(response *externalRegistrationResponse, _ string) {
				response.MCPURL = "/mcp/external#secret"
			},
			wantError:      "userinfo, query, or fragment",
			wantBestEffort: true,
		},
		{
			name: "MCP userinfo",
			mutate: func(response *externalRegistrationResponse, baseURL string) {
				response.MCPURL = strings.Replace(baseURL, "http://", "http://secret@", 1) + "/mcp/external"
			},
			wantError:      "userinfo, query, or fragment",
			wantBestEffort: true,
		},
		{
			name: "MCP empty path",
			mutate: func(response *externalRegistrationResponse, baseURL string) {
				response.MCPURL = baseURL
			},
			wantError:      "resolve to an HTTP path",
			wantBestEffort: true,
		},
		{
			name: "missing capability",
			mutate: func(response *externalRegistrationResponse, _ string) {
				response.Capability = ""
			},
			wantError: "incomplete lease",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stub *httptest.Server
			releases := 0
			stub = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodPost && r.URL.Path == "/api/external-sessions":
					response := externalRegistrationResponse{
						Slug:       "general-weekly-report-friday",
						Owner:      "cognition",
						MCPURL:     "/mcp/external",
						Capability: "per-run-secret",
						ExpiresAt:  time.Now().Add(10 * time.Minute),
					}
					tt.mutate(&response, stub.URL)
					writeExternalRegistration(t, w, response)
				case r.Method == http.MethodDelete &&
					strings.HasPrefix(r.URL.Path, "/api/external-sessions/"):
					if got := r.Header.Get("Authorization"); got != "Bearer per-run-secret" {
						t.Fatalf("best-effort release auth = %q", got)
					}
					releases++
					w.WriteHeader(http.StatusNoContent)
				default:
					http.NotFound(w, r)
				}
			}))
			defer stub.Close()

			client := newHiAgentExternalClient(server.HiAgentConfig{
				BaseURL:      stub.URL,
				SurfaceToken: "surface-secret",
			})
			_, err := client.register(context.Background(), "weekly report", "weekly-report-friday")
			if err == nil || !strings.Contains(err.Error(), tt.wantError) {
				t.Fatalf("register error = %v, want substring %q", err, tt.wantError)
			}
			wantReleases := 0
			if tt.wantBestEffort {
				wantReleases = 1
			}
			if releases != wantReleases {
				t.Fatalf("best-effort releases = %d, want %d", releases, wantReleases)
			}
		})
	}
}

func TestHiAgentExternalClientRejectsUnsafeBaseURL(t *testing.T) {
	for _, raw := range []string{
		"https://127.0.0.1:12358",
		"http://example.com:12358",
		"http://user@127.0.0.1:12358",
		"http://127.0.0.1:12358/prefix",
		"http://127.0.0.1:12358?secret=1",
	} {
		t.Run(raw, func(t *testing.T) {
			client := newHiAgentExternalClient(server.HiAgentConfig{
				BaseURL:      raw,
				SurfaceToken: "surface-secret",
			})
			_, err := client.register(context.Background(), "weekly report", "weekly-report-friday")
			if err == nil || !strings.Contains(err.Error(), "HI_AGENT_BASE_URL") {
				t.Fatalf("register error = %v, want base URL rejection", err)
			}
		})
	}
}

func TestResolveExternalMCPURLAcceptsSameOriginPaths(t *testing.T) {
	base, err := validateHiAgentBaseURL("http://127.0.0.1:12358")
	if err != nil {
		t.Fatalf("validate base: %v", err)
	}
	for raw, want := range map[string]string{
		"/mcp/external":                       "http://127.0.0.1:12358/mcp/external",
		"mcp/custom":                          "http://127.0.0.1:12358/mcp/custom",
		"http://127.0.0.1:12358/mcp/absolute": "http://127.0.0.1:12358/mcp/absolute",
	} {
		t.Run(raw, func(t *testing.T) {
			got, err := resolveExternalMCPURL(base, raw)
			if err != nil {
				t.Fatalf("resolveExternalMCPURL: %v", err)
			}
			if got != want {
				t.Fatalf("resolved MCP URL = %q, want %q", got, want)
			}
		})
	}
}

func TestHiAgentExternalClientDoesNotFollowRegistrationRedirect(t *testing.T) {
	redirected := 0
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected++
		w.WriteHeader(http.StatusCreated)
	}))
	defer sink.Close()

	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, sink.URL+"/stolen", http.StatusTemporaryRedirect)
	}))
	defer stub.Close()

	client := newHiAgentExternalClient(server.HiAgentConfig{
		BaseURL:      stub.URL,
		SurfaceToken: "surface-secret",
	})
	_, err := client.register(context.Background(), "weekly report", "weekly-report-friday")
	if err == nil || !strings.Contains(err.Error(), "HTTP 307") {
		t.Fatalf("register error = %v, want HTTP 307 without redirect", err)
	}
	if redirected != 0 {
		t.Fatalf("redirect target requests = %d, bearer must not be forwarded", redirected)
	}
}

func TestHiAgentExternalReleaseRequiresNoContent(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			writeExternalRegistration(t, w, externalRegistrationResponse{
				Slug:       "general-weekly-report-friday",
				Owner:      "cognition",
				MCPURL:     "/mcp/external",
				Capability: "per-run-secret",
				ExpiresAt:  time.Now().Add(10 * time.Minute),
			})
		case http.MethodDelete:
			if got := r.Header.Get("Authorization"); got != "Bearer per-run-secret" {
				t.Fatalf("release auth = %q", got)
			}
			http.Error(w, "capability rejected", http.StatusUnauthorized)
		default:
			http.NotFound(w, r)
		}
	}))
	defer stub.Close()

	client := newHiAgentExternalClient(server.HiAgentConfig{
		BaseURL:      stub.URL,
		SurfaceToken: "surface-secret",
	})
	lease, err := client.register(context.Background(), "weekly report", "weekly-report-friday")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	err = lease.release(context.Background())
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") ||
		!strings.Contains(err.Error(), "capability rejected") {
		t.Fatalf("release error = %v, want strict 204/status body", err)
	}
}

func writeExternalRegistration(t *testing.T, w http.ResponseWriter, response externalRegistrationResponse) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		t.Fatalf("encode registration: %v", err)
	}
}
