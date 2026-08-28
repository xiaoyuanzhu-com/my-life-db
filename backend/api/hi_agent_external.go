package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"github.com/xiaoyuanzhu-com/my-life-db/server"
)

// hiAgentExternalClient owns the authenticated bridge to hi-agent. It is deliberately
// created from explicit server config rather than from .mcp.json, so one auto-run gets one
// capability and no credential leaks into persistent MCP configuration.
type hiAgentExternalClient struct {
	baseURL      string
	surfaceToken string
	httpClient   *http.Client
}

type externalRegistrationResponse struct {
	Slug       string    `json:"slug"`
	Owner      string    `json:"owner"`
	MCPURL     string    `json:"mcp_url"`
	Capability string    `json:"capability"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type externalSessionLease struct {
	client     *hiAgentExternalClient
	slug       string
	capability string
}

func newHiAgentExternalClient(cfg server.HiAgentConfig) *hiAgentExternalClient {
	if !cfg.Enabled() {
		return nil
	}
	return &hiAgentExternalClient{
		baseURL:      strings.TrimRight(cfg.BaseURL, "/"),
		surfaceToken: cfg.SurfaceToken,
		httpClient:   &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *hiAgentExternalClient) register(
	ctx context.Context,
	title string,
	subject string,
) (*externalSessionLease, error) {
	if c == nil {
		return nil, fmt.Errorf("hi-agent external bridge is not configured")
	}
	body, err := json.Marshal(map[string]string{"title": title, "subject": subject})
	if err != nil {
		return nil, fmt.Errorf("encode hi-agent external registration: %w", err)
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/api/external-sessions",
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, fmt.Errorf("build hi-agent external registration request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.surfaceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("register hi-agent external session: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf(
			"register hi-agent external session: HTTP %s: %s",
			resp.Status,
			readErrorBody(resp.Body),
		)
	}

	var registration externalRegistrationResponse
	if err := json.NewDecoder(resp.Body).Decode(&registration); err != nil {
		return nil, fmt.Errorf("decode hi-agent external registration: %w", err)
	}
	if registration.Slug == "" || registration.Capability == "" || registration.MCPURL == "" {
		return nil, fmt.Errorf("hi-agent external registration returned incomplete lease")
	}
	return &externalSessionLease{
		client:     c,
		slug:       registration.Slug,
		capability: registration.Capability,
	}, nil
}

func (lease *externalSessionLease) mcpServer() acp.McpServer {
	return acp.McpServer{
		Http: &acp.McpServerHttpInline{
			Name: "hi-agent-external-notification",
			Type: "http",
			Url:  lease.client.baseURL + "/mcp/external",
			Headers: []acp.HttpHeader{
				{Name: "Authorization", Value: "Bearer " + lease.capability},
			},
		},
	}
}

func (lease *externalSessionLease) release(ctx context.Context) error {
	if lease == nil || lease.client == nil {
		return nil
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodDelete,
		lease.client.baseURL+"/api/external-sessions/"+url.PathEscape(lease.slug),
		nil,
	)
	if err != nil {
		return fmt.Errorf("build hi-agent external release request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+lease.capability)
	resp, err := lease.client.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("release hi-agent external session: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf(
			"release hi-agent external session: HTTP %s: %s",
			resp.Status,
			readErrorBody(resp.Body),
		)
	}
	return nil
}

func readErrorBody(r io.Reader) string {
	body, err := io.ReadAll(io.LimitReader(r, 4096))
	if err != nil {
		return "unable to read response body"
	}
	return strings.TrimSpace(string(body))
}
