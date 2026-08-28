package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
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
	owner      string
	mcpURL     string
	capability string
	expiresAt  time.Time
}

func newHiAgentExternalClient(cfg server.HiAgentConfig) *hiAgentExternalClient {
	if !cfg.Enabled() {
		return nil
	}
	return &hiAgentExternalClient{
		baseURL:      strings.TrimRight(cfg.BaseURL, "/"),
		surfaceToken: cfg.SurfaceToken,
		httpClient: &http.Client{
			Timeout:       10 * time.Second,
			CheckRedirect: rejectExternalRedirect,
		},
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
	base, err := validateHiAgentBaseURL(c.baseURL)
	if err != nil {
		return nil, err
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
		c.releaseIncompleteRegistration(registration)
		return nil, fmt.Errorf("decode hi-agent external registration: %w", err)
	}
	if registration.Slug == "" || registration.Capability == "" ||
		registration.Owner == "" || registration.MCPURL == "" || registration.ExpiresAt.IsZero() {
		c.releaseIncompleteRegistration(registration)
		return nil, fmt.Errorf("hi-agent external registration returned incomplete lease")
	}
	if registration.Owner != "cognition" {
		c.releaseIncompleteRegistration(registration)
		return nil, fmt.Errorf("hi-agent external registration returned unexpected owner %q", registration.Owner)
	}
	if registration.Owner == registration.Slug {
		c.releaseIncompleteRegistration(registration)
		return nil, fmt.Errorf("hi-agent external registration returned a self-owned lease")
	}
	if !registration.ExpiresAt.After(time.Now()) {
		c.releaseIncompleteRegistration(registration)
		return nil, fmt.Errorf("hi-agent external registration returned an expired lease")
	}
	mcpURL, err := resolveExternalMCPURL(base, registration.MCPURL)
	if err != nil {
		c.releaseIncompleteRegistration(registration)
		return nil, err
	}
	return &externalSessionLease{
		client:     c,
		slug:       registration.Slug,
		owner:      registration.Owner,
		mcpURL:     mcpURL,
		capability: registration.Capability,
		expiresAt:  registration.ExpiresAt,
	}, nil
}

func (lease *externalSessionLease) mcpServer() acp.McpServer {
	return acp.McpServer{
		Http: &acp.McpServerHttpInline{
			Name: "hi-agent-external-notification",
			Type: "http",
			Url:  lease.mcpURL,
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

func (c *hiAgentExternalClient) releaseIncompleteRegistration(registration externalRegistrationResponse) {
	if c == nil || registration.Slug == "" || registration.Capability == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = (&externalSessionLease{
		client:     c,
		slug:       registration.Slug,
		capability: registration.Capability,
	}).release(ctx)
}

func validateHiAgentBaseURL(raw string) (*url.URL, error) {
	base, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid HI_AGENT_BASE_URL: %w", err)
	}
	if base.Scheme != "http" || base.Host == "" || base.User != nil ||
		base.RawQuery != "" || base.Fragment != "" || (base.Path != "" && base.Path != "/") {
		return nil, fmt.Errorf("HI_AGENT_BASE_URL must be a root loopback HTTP origin")
	}
	if !isLoopbackHostname(base.Hostname()) {
		return nil, fmt.Errorf("HI_AGENT_BASE_URL must use a loopback host")
	}
	base.Path = "/"
	return base, nil
}

func resolveExternalMCPURL(base *url.URL, raw string) (string, error) {
	reference, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("invalid hi-agent external MCP URL: %w", err)
	}
	if reference.User != nil || reference.RawQuery != "" || reference.Fragment != "" {
		return "", fmt.Errorf("hi-agent external MCP URL must not contain userinfo, query, or fragment")
	}
	resolved := base.ResolveReference(reference)
	if resolved.Scheme != "http" || resolved.Host == "" || resolved.Path == "" {
		return "", fmt.Errorf("hi-agent external MCP URL must resolve to an HTTP path")
	}
	if !sameHTTPOrigin(base, resolved) || !isLoopbackHostname(resolved.Hostname()) {
		return "", fmt.Errorf("hi-agent external MCP URL must stay on the configured loopback origin")
	}
	return resolved.String(), nil
}

func sameHTTPOrigin(left, right *url.URL) bool {
	return left.Scheme == right.Scheme &&
		strings.EqualFold(left.Hostname(), right.Hostname()) &&
		effectiveHTTPPort(left) == effectiveHTTPPort(right)
}

func effectiveHTTPPort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	if u.Scheme == "http" {
		return "80"
	}
	return ""
}

func isLoopbackHostname(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func rejectExternalRedirect(_ *http.Request, _ []*http.Request) error {
	return http.ErrUseLastResponse
}

func readErrorBody(r io.Reader) string {
	body, err := io.ReadAll(io.LimitReader(r, 4096))
	if err != nil {
		return "unable to read response body"
	}
	return strings.TrimSpace(string(body))
}
