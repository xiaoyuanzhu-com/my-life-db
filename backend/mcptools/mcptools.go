// Package mcptools probes registered MCP servers in <dataDir>/.mcp.json for
// their tool catalogs (the MCP "tools/list" call) and caches the result.
//
// Tool catalogs are runtime properties of each server — there is no way to know
// what tools a server exposes without speaking the MCP protocol to it. This
// package implements a minimal client (HTTP + stdio transports) plus a small
// in-memory cache invalidated on .mcp.json changes (via fsnotify) with a 24h
// TTL backstop.
//
// Concurrency model:
//   - One Cache instance per server, started in server.New().
//   - GetTools is safe to call from multiple goroutines; concurrent calls for
//     the same server name are deduplicated via a per-name singleflight-like
//     guard so we never probe a server twice in parallel.
package mcptools

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// CacheTTL bounds how long a successful probe is kept before re-probing,
// even if .mcp.json hasn't changed. Tool catalogs change rarely (only when the
// server binary itself updates), so a long TTL is safe; this just covers the
// edge case where someone updates a server in place.
const CacheTTL = 24 * time.Hour

// probeTimeout caps the total time spent probing a single server.
const probeTimeout = 8 * time.Second

// Tool mirrors a single entry from an MCP server's tools/list response.
// Only the fields meaningful to the composer UI are surfaced.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	InputSchema map[string]any `json:"inputSchema,omitempty"`
}

// ServerSpec is everything the client needs to talk to one MCP server.
// Built from .mcp.json by readServerSpec; the fsnotify watcher picks up
// changes by invalidating the whole cache (we never partially update).
type ServerSpec struct {
	Name     string
	Type     string // "http" | "stdio" (sse not supported by this client)
	URL      string
	Command  string
	Args     []string
	Env      map[string]string
	Headers  map[string]string
	Disabled bool
}

// HeadersResolver lets the server inject runtime headers (e.g. the ephemeral
// Authorization bearer token used by mylifedb-builtin internal MCP). Returns
// nil to leave headers untouched. Called once per probe.
type HeadersResolver func(spec ServerSpec) map[string]string

// Cache holds tool lists by server name with TTL + fsnotify invalidation.
type Cache struct {
	dataDir         string
	headersResolver HeadersResolver

	mu      sync.Mutex
	entries map[string]*cacheEntry

	// inflight deduplicates concurrent GetTools calls for the same name.
	inflight map[string]*inflightCall

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

type cacheEntry struct {
	tools []Tool
	at    time.Time
}

type inflightCall struct {
	done  chan struct{}
	tools []Tool
	err   error
}

// New creates a Cache rooted at dataDir (where .mcp.json lives). The optional
// headersResolver is called for each probe to add transport-specific headers
// (e.g. the internal MCP bearer token). dataDir is used directly as the
// fsnotify target's parent — we watch the directory and filter by filename.
func New(dataDir string, headersResolver HeadersResolver) *Cache {
	return &Cache{
		dataDir:         dataDir,
		headersResolver: headersResolver,
		entries:         map[string]*cacheEntry{},
		inflight:        map[string]*inflightCall{},
	}
}

// Start launches the fsnotify watcher goroutine. Safe to call once; subsequent
// calls are no-ops. Returns an error only if the watcher fails to attach.
func (c *Cache) Start(ctx context.Context) error {
	if c.cancel != nil {
		return nil
	}
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("mcptools: create watcher: %w", err)
	}
	// Watch the parent directory and filter for .mcp.json events. Editors
	// often save by writing a temp file and renaming over the target, which
	// invalidates a direct file watch; watching the parent is robust.
	if err := w.Add(c.dataDir); err != nil {
		w.Close()
		return fmt.Errorf("mcptools: watch %s: %w", c.dataDir, err)
	}
	cctx, cancel := context.WithCancel(ctx)
	c.cancel = cancel
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer w.Close()
		c.watchLoop(cctx, w)
	}()
	log.Info().Str("dataDir", c.dataDir).Msg("mcptools: cache started")
	return nil
}

// Stop signals the watcher to exit and waits for it. Idempotent.
func (c *Cache) Stop() {
	if c.cancel != nil {
		c.cancel()
		c.cancel = nil
	}
	c.wg.Wait()
}

func (c *Cache) watchLoop(ctx context.Context, w *fsnotify.Watcher) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-w.Events:
			if !ok {
				return
			}
			if filepath.Base(ev.Name) != ".mcp.json" {
				continue
			}
			// Any change (write, create, rename, remove) wipes the cache.
			// Cheaper than diffing — probes are lazy and individual.
			log.Info().Str("op", ev.Op.String()).Msg("mcptools: .mcp.json changed, invalidating cache")
			c.invalidate()
		case err, ok := <-w.Errors:
			if !ok {
				return
			}
			log.Warn().Err(err).Msg("mcptools: watcher error")
		}
	}
}

func (c *Cache) invalidate() {
	c.mu.Lock()
	c.entries = map[string]*cacheEntry{}
	c.mu.Unlock()
}

// GetTools returns the tool list for the named server, probing if the cache
// is empty or stale. Concurrent calls for the same name share one probe.
func (c *Cache) GetTools(ctx context.Context, name string) ([]Tool, error) {
	// Fast path: fresh cache hit.
	c.mu.Lock()
	if e, ok := c.entries[name]; ok && time.Since(e.at) < CacheTTL {
		tools := e.tools
		c.mu.Unlock()
		return tools, nil
	}
	// Inflight dedup: if another goroutine is already probing this server,
	// wait for it instead of issuing a duplicate probe.
	if call, ok := c.inflight[name]; ok {
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-call.done:
			return call.tools, call.err
		}
	}
	call := &inflightCall{done: make(chan struct{})}
	c.inflight[name] = call
	c.mu.Unlock()

	tools, err := c.probe(ctx, name)

	c.mu.Lock()
	delete(c.inflight, name)
	if err == nil {
		c.entries[name] = &cacheEntry{tools: tools, at: time.Now()}
	}
	c.mu.Unlock()

	call.tools = tools
	call.err = err
	close(call.done)
	return tools, err
}

func (c *Cache) probe(ctx context.Context, name string) ([]Tool, error) {
	spec, err := readServerSpec(c.dataDir, name)
	if err != nil {
		return nil, err
	}
	if spec.Disabled {
		return nil, fmt.Errorf("server %q is disabled", name)
	}
	if c.headersResolver != nil {
		extra := c.headersResolver(spec)
		if spec.Headers == nil {
			spec.Headers = map[string]string{}
		}
		for k, v := range extra {
			spec.Headers[k] = v
		}
	}
	pctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	switch spec.Type {
	case "http", "":
		// Default to http when type is omitted but a URL is set — matches
		// the Claude Code .mcp.json convention.
		if spec.URL == "" {
			return nil, fmt.Errorf("server %q has no url", name)
		}
		return probeHTTP(pctx, spec.URL, spec.Headers)
	case "stdio":
		if spec.Command == "" {
			return nil, fmt.Errorf("server %q has no command", name)
		}
		return probeStdio(pctx, spec.Command, spec.Args, spec.Env)
	case "sse":
		return nil, fmt.Errorf("server %q uses sse transport, not supported", name)
	default:
		return nil, fmt.Errorf("server %q has unknown type %q", name, spec.Type)
	}
}

// readServerSpec parses .mcp.json and returns the spec for one server.
// Returns os.ErrNotExist if the server is missing. Tolerates extra fields.
func readServerSpec(dataDir, name string) (ServerSpec, error) {
	doc, err := readMCPDoc(dataDir)
	if err != nil {
		return ServerSpec{}, err
	}
	cfg, ok := doc[name]
	if !ok {
		return ServerSpec{}, fmt.Errorf("server %q not found in .mcp.json", name)
	}
	return parseServerEntry(name, cfg), nil
}

// AllSpecs reads every server entry from .mcp.json and returns them. Returns
// os.ErrNotExist if the file is missing. Disabled servers are included with
// the Disabled flag set; callers filter as needed.
func AllSpecs(dataDir string) ([]ServerSpec, error) {
	doc, err := readMCPDoc(dataDir)
	if err != nil {
		return nil, err
	}
	out := make([]ServerSpec, 0, len(doc))
	for name, cfg := range doc {
		out = append(out, parseServerEntry(name, cfg))
	}
	return out, nil
}

func readMCPDoc(dataDir string) (map[string]map[string]any, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, ".mcp.json"))
	if err != nil {
		return nil, err
	}
	var doc struct {
		MCPServers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse .mcp.json: %w", err)
	}
	return doc.MCPServers, nil
}

func parseServerEntry(name string, cfg map[string]any) ServerSpec {
	spec := ServerSpec{Name: name}
	if v, ok := cfg["type"].(string); ok {
		spec.Type = v
	}
	if v, ok := cfg["url"].(string); ok {
		spec.URL = v
	}
	if v, ok := cfg["command"].(string); ok {
		spec.Command = v
	}
	if v, ok := cfg["disabled"].(bool); ok {
		spec.Disabled = v
	}
	if arr, ok := cfg["args"].([]any); ok {
		for _, a := range arr {
			if s, ok := a.(string); ok {
				spec.Args = append(spec.Args, s)
			}
		}
	}
	if m, ok := cfg["env"].(map[string]any); ok {
		spec.Env = map[string]string{}
		for k, v := range m {
			if s, ok := v.(string); ok {
				spec.Env[k] = s
			}
		}
	}
	if m, ok := cfg["headers"].(map[string]any); ok {
		spec.Headers = map[string]string{}
		for k, v := range m {
			if s, ok := v.(string); ok {
				spec.Headers[k] = s
			}
		}
	}
	return spec
}

// JSON-RPC 2.0 wire types. Kept minimal — we only need request, response, and
// the small subset of MCP methods used to enumerate tools.
type jsonrpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type jsonrpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func initializeParams() map[string]any {
	return map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo": map[string]any{
			"name":    "mylifedb-mcptools",
			"version": "1.0.0",
		},
	}
}

// ----- HTTP transport -----

// probeHTTP performs the minimal MCP handshake over streamable HTTP:
// initialize → (optional notifications/initialized) → tools/list. Captures
// the optional Mcp-Session-Id header and replays it on subsequent calls,
// since some servers require it after initialize.
func probeHTTP(ctx context.Context, url string, headers map[string]string) ([]Tool, error) {
	client := &http.Client{}

	// 1. initialize
	respBody, sessionID, err := httpRPC(ctx, client, url, "", headers, jsonrpcRequest{
		JSONRPC: "2.0", ID: 1, Method: "initialize", Params: initializeParams(),
	})
	if err != nil {
		return nil, fmt.Errorf("initialize: %w", err)
	}
	if respBody.Error != nil {
		return nil, fmt.Errorf("initialize: %s", respBody.Error.Message)
	}

	// 2. notifications/initialized — best-effort; some servers ignore, some
	// require it. Not all servers respond (no ID), so swallow errors.
	_, _, _ = httpRPC(ctx, client, url, sessionID, headers, jsonrpcRequest{
		JSONRPC: "2.0", Method: "notifications/initialized",
	})

	// 3. tools/list
	respBody, _, err = httpRPC(ctx, client, url, sessionID, headers, jsonrpcRequest{
		JSONRPC: "2.0", ID: 2, Method: "tools/list",
	})
	if err != nil {
		return nil, fmt.Errorf("tools/list: %w", err)
	}
	if respBody.Error != nil {
		return nil, fmt.Errorf("tools/list: %s", respBody.Error.Message)
	}
	return parseToolsResult(respBody.Result)
}

// httpRPC posts one JSON-RPC frame and returns the parsed response plus any
// Mcp-Session-Id assigned by the server. Handles both application/json and
// text/event-stream responses (streamable HTTP transport).
func httpRPC(ctx context.Context, client *http.Client, url, sessionID string, headers map[string]string, req jsonrpcRequest) (*jsonrpcResponse, string, error) {
	body, _ := json.Marshal(req)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json, text/event-stream")
	if sessionID != "" {
		httpReq.Header.Set("Mcp-Session-Id", sessionID)
	}
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	newSession := resp.Header.Get("Mcp-Session-Id")
	if newSession == "" {
		newSession = sessionID
	}

	// Notifications (no ID) get 202 Accepted with no body — short-circuit.
	if resp.StatusCode == http.StatusAccepted {
		return nil, newSession, nil
	}
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, newSession, fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	ct := resp.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "text/event-stream") {
		// Streamable HTTP: read SSE events until we find one with a `data:`
		// line we can parse as a jsonrpcResponse matching this request's ID.
		parsed, err := readSSEResponse(resp.Body, req.ID)
		return parsed, newSession, err
	}
	// Plain application/json response.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, newSession, err
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, newSession, nil
	}
	var parsed jsonrpcResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, newSession, fmt.Errorf("parse json response: %w", err)
	}
	return &parsed, newSession, nil
}

// readSSEResponse reads SSE frames and returns the first jsonrpcResponse with
// an `id` matching wantID. Other frames (server-initiated notifications, etc.)
// are skipped. Returns io.EOF if the stream closes without a match.
func readSSEResponse(r io.Reader, wantID int) (*jsonrpcResponse, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 4096), 1<<20)
	var dataLines []string
	flush := func() (*jsonrpcResponse, bool, error) {
		if len(dataLines) == 0 {
			return nil, false, nil
		}
		payload := strings.Join(dataLines, "\n")
		dataLines = dataLines[:0]
		var parsed jsonrpcResponse
		if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
			// Skip frames we can't parse — they may not be JSON-RPC.
			return nil, false, nil
		}
		// ID match: parsed.ID is RawMessage; compare numerically.
		var gotID int
		if err := json.Unmarshal(parsed.ID, &gotID); err == nil && gotID == wantID {
			return &parsed, true, nil
		}
		return nil, false, nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			// End of one SSE event.
			if resp, matched, err := flush(); err != nil {
				return nil, err
			} else if matched {
				return resp, nil
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue // SSE comment
		}
		if v, ok := strings.CutPrefix(line, "data:"); ok {
			dataLines = append(dataLines, strings.TrimPrefix(v, " "))
		}
		// Other fields (event:, id:, retry:) are ignored.
	}
	// Flush the trailing buffer if the stream ended without a blank line.
	if resp, matched, err := flush(); err != nil {
		return nil, err
	} else if matched {
		return resp, nil
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("sse stream closed without matching response")
}

// ----- stdio transport -----

// probeStdio spawns the configured command and exchanges JSON-RPC frames
// over its stdin/stdout. The process is killed as soon as we have the tool
// list; this is a one-shot probe, not a long-lived session.
func probeStdio(ctx context.Context, command string, args []string, env map[string]string) ([]Tool, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), formatEnv(env)...)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", command, err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()

	reader := bufio.NewReader(stdout)
	send := func(req jsonrpcRequest) error {
		body, _ := json.Marshal(req)
		body = append(body, '\n')
		_, err := stdin.Write(body)
		return err
	}
	recv := func(wantID int) (*jsonrpcResponse, error) {
		// Stdio framing is line-delimited JSON; one response per line.
		// Skip server-initiated notifications (no matching id) until we
		// see ours. Bound the search to 32 lines so a chatty server can't
		// hang the probe.
		for i := 0; i < 32; i++ {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return nil, err
			}
			if len(bytes.TrimSpace(line)) == 0 {
				continue
			}
			var parsed jsonrpcResponse
			if err := json.Unmarshal(line, &parsed); err != nil {
				continue
			}
			var gotID int
			if err := json.Unmarshal(parsed.ID, &gotID); err == nil && gotID == wantID {
				return &parsed, nil
			}
		}
		return nil, errors.New("stdio: no matching response within 32 frames")
	}

	if err := send(jsonrpcRequest{JSONRPC: "2.0", ID: 1, Method: "initialize", Params: initializeParams()}); err != nil {
		return nil, err
	}
	if _, err := recv(1); err != nil {
		return nil, fmt.Errorf("initialize: %w", err)
	}
	// notifications/initialized has no id, no response expected.
	_ = send(jsonrpcRequest{JSONRPC: "2.0", Method: "notifications/initialized"})

	if err := send(jsonrpcRequest{JSONRPC: "2.0", ID: 2, Method: "tools/list"}); err != nil {
		return nil, err
	}
	resp, err := recv(2)
	if err != nil {
		return nil, fmt.Errorf("tools/list: %w", err)
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("tools/list: %s", resp.Error.Message)
	}
	return parseToolsResult(resp.Result)
}

func formatEnv(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	return out
}

// parseToolsResult extracts the `tools` array from the result body of a
// tools/list response. The MCP shape is { tools: [...], nextCursor?: "..." }.
// We ignore pagination — the composer UI only needs the first page, and very
// few servers paginate tool listings.
func parseToolsResult(raw json.RawMessage) ([]Tool, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var body struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("parse tools/list result: %w", err)
	}
	return body.Tools, nil
}
