# Image I/O in ACP Sessions — Design

Let agent sessions emit images (and accept image references) through dedicated MCP tools that call `gpt-image-2` via the existing LiteLLM proxy. Image *input* keeps using the existing attachment + `@<path>` flow. Image *output* becomes two uniform MCP tools — `generateImage` and `editImage` — exposed to every ACP agent (Claude Code, Codex, Gemini, Qwen, opencode), independent of whether the underlying chat model is multimodal.

## Goals

- A single code path for "the model wants to produce an image" that works across all five ACP agents and all chat models the user configures (multimodal or text-only).
- Generated images land as real files in the user's workspace — consistent with MyLifeDB's "filesystem is the source of truth" model, so they survive sessions, sync, and search.
- The model can also reference the freshly generated image inline in its turn (so the user sees it in the bubble without scrolling to a directory).
- Cost and quality are explicit per call (`size`, `quality`), routed through the existing LiteLLM proxy where `gpt-image-2` is already configured with cost tracking.

## Non-goals

- No native-multimodal-output path. We are *not* trying to coax `gpt-5.5` (or any chat model) into emitting `image` content blocks through ACP. See "Why MCP, not native" below.
- No streaming partial images. `partial_images` is only available on `/v1/responses` (not on `/v1/images/generations`); we accept the few-seconds wall-clock for v1.
- No model fan-out. Always `gpt-image-2`. If the user wants to swap models, they change LiteLLM config — not MyLifeDB code.
- No batch / multi-image-per-call. `n` is hard-coded to 1; if a session needs multiple variations it can call the tool multiple times.

## Why MCP, not native multimodal output

The original temptation was: "if the chat model supports image output, just let the agent emit `image` content blocks and forward them through ACP." That doesn't work in practice today (2026-04-26):

| Layer | State |
|-------|-------|
| Chat model (`gpt-5.5`) | Released 2026-04-23. Capable of image output via the `image_generation` tool on `/v1/responses`. |
| ACP transport | Supports image content blocks bidirectionally (MIME-typed `parts`). Not the bottleneck. |
| Agent CLI (Codex, Claude Code, Gemini, Qwen, opencode) | **None of them** uniformly registers an `image_generation` tool with the model when running as an ACP server. The Codex CLI gained an `$imagegen` skill in standalone mode with the 2026-04-23 release but ACP-mode parity is unconfirmed and not the case for the other four agents. |

So even with a fully image-capable model behind the wire, the agent CLI in the middle gives the model only shell + write tools. The model produces images by writing Python or SVG (this is exactly the failure mode that prompted this design — see the `apple.svg` fallback in the user's session).

An MCP tool sidesteps the entire question. MCP tools are model-callable across every ACP agent that supports MCP (all five do). The tool implementation hits `/v1/images/generations` directly and returns the result through the MCP `tool_result` channel, which agents already render. One code path, five agents, any chat model.

## The MCP tools

Registered in [backend/agentrunner/mcp.go](my-life-db/backend/agentrunner/mcp.go) alongside the existing `validateAgent` tool.

### `generateImage`

```jsonc
{
  "name": "generateImage",
  "description": "Generate a new image from a text prompt using gpt-image-2. The image is saved to the user's workspace and also returned inline so it appears in the conversation. Use for icons, illustrations, mockups, diagrams the user asks for.",
  "inputSchema": {
    "type": "object",
    "required": ["prompt"],
    "properties": {
      "prompt": {
        "type": "string",
        "description": "Detailed description of the image to generate. Be specific about subject, style, composition, colors."
      },
      "size": {
        "type": "string",
        "enum": ["1024x1024", "1536x1024", "1024x1536", "auto"],
        "default": "1024x1024"
      },
      "quality": {
        "type": "string",
        "enum": ["low", "medium", "high", "auto"],
        "default": "medium",
        "description": "Higher quality costs more. low=$0.006, medium=$0.053, high=$0.211 per 1024x1024 image."
      },
      "background": {
        "type": "string",
        "enum": ["transparent", "opaque", "auto"],
        "description": "Optional. 'transparent' is useful for icons/logos."
      },
      "filename": {
        "type": "string",
        "description": "Optional. Filename hint (no extension). Defaults to a slug of the prompt. Always saved as .png."
      }
    }
  }
}
```

### `editImage`

```jsonc
{
  "name": "editImage",
  "description": "Edit an existing image using gpt-image-2. Source image is read from disk by absolute path. Use for changing colors, adding/removing elements, applying styles, or inpainting (with optional mask). Output is saved as edited-<slug>-<hash>.png alongside generated images.",
  "inputSchema": {
    "type": "object",
    "required": ["prompt", "imagePath"],
    "properties": {
      "prompt": { "type": "string" },
      "imagePath": {
        "type": "string",
        "description": "Absolute path to source image (PNG, JPEG, or WebP). Max 20 MB."
      },
      "maskPath": {
        "type": "string",
        "description": "Optional absolute path to a PNG mask. Transparent pixels mark edit zones; opaque pixels are preserved."
      },
      "size": { /* same as generateImage */ },
      "quality": { /* same as generateImage */ },
      "background": { /* same as generateImage */ },
      "filename": { "type": "string" }
    }
  }
}
```

The endpoint is multipart/form-data, not JSON. Source image bytes are uploaded as a file part; the MCP tool implementation reads from disk and constructs the multipart body. Same response shape as `generateImage`.

### Tool result — `structuredContent` + `[mylifedb-image]` marker

Each tool returns the same payload in **two places** by design:

1. **`structuredContent`** on `CallToolResult`. This is the MCP 2025-06-18 native field for typed tool results. Each tool also declares an `outputSchema` so spec-aware clients can validate the payload. This is the "right" answer per spec.
2. **`[mylifedb-image] <JSON>` marker line** at the end of the text content block. The MCP spec itself recommends this even when `structuredContent` is set: *"For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block."* We rely on it because the agent CLI (Claude Code, observed 2026-04-28) silently drops fields it doesn't recognize when forwarding to ACP — `structuredContent`, `_meta`, and `resource_link` all vanish today. **Text content is the only thing that always survives**, regardless of agent CLI version. The frontend prefers `structuredContent` when present, falls back to the marker.

The text content block looks like:

```text
Generated image saved to /abs/path/.../generated/2026-04-26/cute-otter-3a4b5c.png
Relative path (under USER_DATA_DIR): generated/2026-04-26/cute-otter-3a4b5c.png
Size: 87.3 KB.
Model's revised prompt: A small fluffy otter ...

[mylifedb-image] {"op":"generated","absPath":"/abs/path/.../cute-otter-3a4b5c.png","relPath":"generated/2026-04-26/cute-otter-3a4b5c.png","mimeType":"image/png","bytes":89401,"revisedPrompt":"..."}
```

**Survival matrix.** Observation of two real `tool_call_update` frames from Claude Code's CLI on 2026-04-28:

| What we sent                                                  | What arrived at the ACP client                                                                            |
|---------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| `_meta.mylifedb/image`                                        | **dropped** (replaced with `_meta.claudeCode.toolName`)                                                   |
| `resource_link` content block                                 | **rewritten** to plain text: `"[Resource link: <name>] file://<uri>"`                                     |
| `structuredContent: {...}` + custom prose text block          | text block **replaced** with `JSON.stringify(structuredContent)`; `rawOutput` is the same JSON string     |
| `structuredContent: {...}` (no custom text)                   | one text block containing `JSON.stringify(structuredContent)`; `rawOutput` likewise                       |
| Plain text content block (no `structuredContent`)             | **preserved verbatim**                                                                                    |

This is actually following the MCP 2025-06-18 spec: *"For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block."* Claude Code does this for us — it overwrites whatever text we sent with the canonical JSON serialization. So the on-the-wire contract simplifies to: **`rawOutput` will be a JSON string of `structuredContent` whenever `structuredContent` is present**. The frontend parses that JSON directly. The `[mylifedb-image]` marker remains as a fallback for agent CLIs that don't rewrite text.

**The base64 image is not included inline.** Inlining a 1024×1024 PNG (~2.5 MB base64) per call would burn ~640K text tokens or ~1500 vision tokens of model context, with no upside — the model just generated the image; it doesn't need to re-see the bytes. It just needs the path so it can pass it to `editImage` for follow-ups or reference it in later turns.

The image is rendered to the user by the **frontend**, not the model. The frontend's image renderer ([frontend/app/components/agent/tools/image-tool.tsx](my-life-db/frontend/app/components/agent/tools/image-tool.tsx)) walks the result for any text block containing the `[mylifedb-image]` marker, parses the JSON, and renders `<img src="/raw/<relPath>" />` inline using the existing `/raw/<path>` static endpoint.

This separation matches every production AI image flow (DALL-E, Midjourney): tools return a path/URL, never bytes.

> **Note on stripping (temporary)**: the backend's `agentsdk.StripHeavyToolCallContent` previously stripped `content[]` and (most) `rawOutput` from `tool_call_update` frames as a wire-size optimization. That stripping is currently **disabled at the call sites** in `backend/agentsdk/acpclient.go` so the image renderer can see the MCP result. Re-enable as a per-tool allowlist once the rendering path is settled.

## Storage

```
USER_DATA_DIR/generated/<YYYY-MM-DD>/<slug>-<short-hash>.png
```

- Lives in `USER_DATA_DIR` (not `APP_DATA_DIR`) — generated images are user content. They're served by the existing `/raw/*path` handler, indexed by the file watcher / digest worker, and visible in the user's library / inbox flow.
- Per-day subdirectory keeps the folder scannable as the library grows.
- `<slug>` from the user's `filename` arg if provided, else a slugified prompt prefix (max 40 chars).
- `<short-hash>` is the first 6 chars of the SHA-256 of the PNG bytes — guarantees uniqueness without collisions when the user generates many images with the same prompt.
- Stored as `.png` only. `gpt-image-2` returns PNG by default.
- Not garbage-collected. The user deletes them like any other file.

## Backend implementation

### New file: `backend/agentrunner/image.go`

A small helper that owns the LiteLLM call and disk write. Keeps `mcp.go` thin.

```go
package agentrunner

type ImageGenRequest struct {
    Prompt   string
    Size     string // default 1024x1024
    Quality  string // default medium
    Filename string // optional
}

type ImageGenResult struct {
    AbsPath  string
    B64Data  string // for inline tool_result
    Bytes    int
}

// GenerateImage POSTs to ${OPENAI_BASE_URL}/v1/images/generations with
// model=gpt-image-2, response_format=b64_json, then writes the bytes to
// APP_DATA_DIR/generated/... and returns both the path and the b64.
func GenerateImage(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error) { ... }
```

Auth and base URL come from the same settings the chat path uses ([backend/vendors/openai.go:60-105](my-life-db/backend/vendors/openai.go#L60-L105)) — `settings.Vendors.OpenAI.{APIKey,BaseURL}` with env-var fallback. No new config keys.

### Changes to `backend/agentrunner/mcp.go`

1. **Tools list** ([backend/agentrunner/mcp.go:123](my-life-db/backend/agentrunner/mcp.go#L123)) — append the `generateImage` tool entry next to `validateAgent`.
2. **Tools call** ([backend/agentrunner/mcp.go:170](my-life-db/backend/agentrunner/mcp.go#L170)) — add `case "generateImage":` that decodes args, calls `GenerateImage`, and returns the mixed-content `tool_result` shown above.
3. **No new auth surface.** The existing localhost-trust + optional bearer token applies unchanged.

### LiteLLM call shape

**Generate** — `POST {AGENT_BASE_URL}/images/generations`, JSON body:

```json
{
  "model": "gpt-image-2",
  "prompt": "...",
  "size": "1024x1024",
  "quality": "medium",
  "n": 1,
  "background": "transparent"
}
```

**Note: do NOT send `response_format`.** Unlike `gpt-image-1`, `gpt-image-2` does not accept this field and returns a 400. The response always contains `data[].b64_json` and a null `data[].url`.

**Edit** — `POST {AGENT_BASE_URL}/images/edits`, multipart/form-data:

```
model=gpt-image-2
prompt=<edit instruction>
size=1024x1024
quality=medium
n=1
image=@<source.png>          # required, file part
mask=@<mask.png>              # optional, file part — transparent = edit zone
```

Both endpoints share the same response shape — `{"data":[{"b64_json":"...","revised_prompt":"...","url":null}], "usage":{...}}`. Extract `data[0].b64_json`, decode, write to disk, return inline.

LiteLLM is already configured with `gpt-image-2` (manual config + cost tracking, verified working). MCP tool calls appear in LiteLLM's usage logs alongside chat completions, attributed to the same MyLifeDB key.

### Transport: SSE for slow tools/call

`gpt-image-2` at medium quality takes 30–90 seconds for a 1024×1024 PNG. Agent CLIs (Claude Code, Codex, etc.) ship with a default ~60s read timeout on MCP HTTP responses. A blocking `application/json` reply gets killed mid-flight: server eventually finishes, tries to write the 2.5 MB JSON, gets `broken pipe`, and the model sees no result and reports "tool ran without returning output" — observed in production with a 64-second generation.

Per MCP's streamable HTTP spec (rev 2024-11-05), when the client's `Accept` header includes `text/event-stream`, the server MAY respond as an SSE stream. We use this for `tools/call`:

1. Set `Content-Type: text/event-stream`, write `200 OK`, flush headers immediately so the client's read timeout doesn't fire while the tool runs.
2. Spawn a goroutine to execute the tool.
3. Send a `: keepalive\n\n` SSE comment every 15 seconds (well under the typical 60s timeout).
4. When the tool completes, write the JSON-RPC response as a single `data: <json>\n\n` SSE event and close the stream.

For tools/list, initialize, and clients that don't advertise SSE in `Accept`, we fall back to the existing direct JSON path. Validation done in [backend/agentrunner/image_test.go](my-life-db/backend/agentrunner/image_test.go) — both SSE and JSON paths covered.

### Failure modes

| Failure | Handling |
|---------|----------|
| `OPENAI_API_KEY` missing | Tool returns `{"isError": true, "content": [{"type":"text","text":"OpenAI not configured"}]}`. Model can fall back to writing SVG/Python (current behavior) or apologize. |
| LiteLLM 4xx (bad model, content policy) | Forward the error message in the tool result text. The model usually recovers by adjusting the prompt. |
| LiteLLM 5xx / network error | Single retry with 500ms backoff, then surface the error. |
| Disk write fails (full, permission) | Return the b64 inline only, with text noting the disk failure. |

## Frontend

A dedicated tool renderer at [frontend/app/components/agent/tools/image-tool.tsx](my-life-db/frontend/app/components/agent/tools/image-tool.tsx) handles `generateImage` / `editImage` tool calls. The dispatcher in [frontend/app/components/agent/tool-dispatch.tsx](my-life-db/frontend/app/components/agent/tool-dispatch.tsx) routes any tool whose `metaToolName` or `title` includes "generateImage" / "editImage" to it.

The renderer reads the MCP tool result via `result._meta["mylifedb/image"]` (with content-block fallbacks — see "Frontend extraction order" above), then renders `<img src="/raw/<relPath>" />` inline with a max-height clamp. Prompt and (optional) revised prompt show as caption / expandable details. If the image fails to load, an inline error appears with the attempted URL.

The composer's `+` attachment button (from [docs/plans/2026-04-22-agent-attachments-design.md](my-life-db/docs/plans/2026-04-22-agent-attachments-design.md)) handles image *input*. No changes there.

## Reach across the five ACP agents

| Agent | MCP support | `tool_result` image block rendered |
|-------|-------------|-------------------------------------|
| Claude Code | ✅ native MCP | ✅ |
| Codex | ✅ via `--mcp` | ✅ (also has its own `$imagegen` standalone, which we ignore) |
| Gemini CLI | ✅ MCP servers in config | ✅ |
| Qwen Code | ✅ MCP via OpenAI tool-call shim | ✅ |
| opencode | ✅ MCP via plugin | ✅ |

Same MCP server, same tool, same result, all five agents.

## Open questions

1. **Default quality.** "medium" at $0.053/image is ~9× the price of "low" at $0.006. v1 default of `medium` errs toward "looks good"; if usage costs spike we can flip to `low` and let the model upgrade explicitly via the `quality` arg.
2. **Per-session quota.** Out of scope for v1, but if a runaway agent loop spammed `generateImage` it could rack up real cost. Future: add a per-session call counter in `agentrunner.Runner` and refuse after N calls per session.
3. **Source-image size cap.** `editImage` rejects sources larger than 20 MB (well above any 1024×1024 PNG/JPEG/WebP). Could be lifted if a real workflow needs it.

## Implementation checklist

1. Add `backend/agentrunner/image.go` with `GenerateImage` and `EditImage`.
2. Wire `generateImage` and `editImage` into `mcp.go` (tools list + tools call dispatch).
3. Unit tests in `backend/agentrunner/image_test.go` covering: tools listed, request shape (no `response_format`, multipart for edit), file written, error forwarding, mask part, MIME type detection, MCP tool surface.
4. Manual smoke test against each ACP agent (Claude Code first, then Codex) — verify image renders inline and file lands on disk.
5. Update [my-life-db-docs/src/content/docs/tech-design/](my-life-db-docs/src/content/docs/tech-design/) with an "Image I/O" page referencing this design once landed.
