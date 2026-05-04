# Integration Surfaces — Design

Make MyLifeDB a landing zone for any third-party app that can push files. Ship three protocol surfaces — **HTTP webhook**, **WebDAV**, **S3-compatible** — each off by default, each with its own per-protocol credential, all path-scoped against the existing Connect scope model so the security story is uniform across OAuth and on-demand integrations.

## Motivation

There are too many apps in the personal-data ecosystem to integrate one by one. Instead of building a Health-Auto-Export-specific webhook, a Strava-specific OAuth client, a Garmin-specific poller, etc., MyLifeDB exposes a small set of standard ingestion protocols and lets the long tail bring its own client. The data lands as files; parsing/normalization is a separate concern handled by skills and agents.

Apple Health is the first example (Health Auto Export → webhook), but the same surfaces will serve backup tools (rclone → S3), iOS apps (Files → WebDAV), homelab automations (Home Assistant → webhook), and anything else the user can point at a URL.

## Non-goals

- **No first-party app integrations in scope.** This plan only ships ingestion surfaces, not Strava/Garmin/Notion connectors.
- **No public-internet exposure tooling.** Cloudflare Tunnel / Tailscale / ngrok setup is documented, not bundled.
- **No payload parsing or transformation.** Bytes land at a path; format-specific interpretation lives elsewhere (skills, agents, future digest workers).
- **No new OAuth surfaces.** Connect (existing) handles OAuth-based integrations. This plan handles everything that can't or won't speak OAuth.

## Harmonization with the existing API structure

The current `routes.go` lays down a clean three-tier convention:

```
tier      | namespaces
--------- | --------------------------------
product   | /api/data/, /api/agent/, /api/explore/
protocol  | /api/connect/, /api/mcp/
admin     | /api/system/
```

Plus four byte-I/O surfaces outside `/api/`:

```
/raw/*path        — owner + Connect-scoped file I/O
/sqlar/*path      — archive serving
/connect/token    — OAuth token endpoint
/.well-known/...  — RFC 8414 discovery
```

Connect (`backend/connect/scope.go`) already defines the path-scope model: `files.read:<path>` and `files.write:<path>`, parsed at the authorize boundary, enforced by `RequireConnectScope` middleware.

**Integration surfaces plug into this same model.** Each new credential resolves to a `connect.ScopeSet` at request time; the existing `RequireConnectScope` middleware then does the path check. We do *not* invent a parallel scope vocabulary or a parallel path-prefix scheme.

What's new: how the credential is *transported* on the wire.

| Surface | Transport | Credential format | Path source |
|---|---|---|---|
| HTTP webhook | `Authorization: Bearer <token>` (or `?token=`) | opaque bearer token | URL `*path` |
| WebDAV | HTTP Basic (`username:app-password`) | username + bcrypted secret | WebDAV request path |
| S3 | AWS SigV4 signed request | access key ID + secret | S3 object key |

All three resolve to "this credential maps to ScopeSet S; does S satisfy the request path with the required action?". Same answer-shape as Connect — the OAuth authorization flow is replaced by "user clicked Generate Credential in settings".

## Namespace placement

Integration credentials are owner-side admin state (like Connect clients). They belong under **`/api/connect/`** alongside the OAuth client admin, because they're the same conceptual thing — *third-party access grants* — just minted manually rather than via a consent flow.

```
/api/connect/clients          (existing) — OAuth clients
/api/connect/credentials      (new)      — webhook / webdav / s3 credentials
```

Why not a new `/api/integrations/*` group?
- Splits the same concept (third-party access) across two settings pages.
- Doubles the audit trail (Connect already logs grant usage).
- Adds a fourth tier to the routes table for one feature.

The settings UI can still surface them under one "Integrations" page client-side; that's a frontend concern.

The byte-I/O endpoints themselves (the actual webhook URL, the WebDAV mount, the S3 bucket endpoint) live **outside `/api/`** alongside `/raw/` and `/connect/` because they're protocol surfaces, not REST endpoints:

```
/raw/*path                    (existing) — owner + Connect file I/O
/connect/token                (existing) — OAuth token mint
/webhook/*path                (new)      — HTTP webhook ingest
/webdav/*                     (new)      — WebDAV mount
/s3/*                         (new)      — S3-compatible API
```

## Credential model

Single table, protocol-discriminated:

```sql
CREATE TABLE integration_credentials (
  id              TEXT PRIMARY KEY,           -- UUID
  name            TEXT NOT NULL,              -- user-given: "Health Auto Export iCloud"
  protocol        TEXT NOT NULL,              -- "webhook" | "webdav" | "s3"
  -- Auth material (interpretation depends on protocol):
  --   webhook: secret_hash = bcrypt(bearer token); public_id is unused
  --   webdav:  secret_hash = bcrypt(app password);  public_id = username
  --   s3:      secret_hash = bcrypt(secret key);    public_id = access key ID
  public_id       TEXT,                       -- shown in settings; used as auth lookup key
  secret_hash     TEXT NOT NULL,              -- bcrypt of the secret (one-time reveal at creation)
  secret_prefix   TEXT NOT NULL,              -- first 8 chars of the secret for display ("hae_a3f2…")
  -- Authorization: reuse Connect scope strings verbatim.
  scope           TEXT NOT NULL,              -- e.g. "files.write:/imports/fitness/apple-health"
  -- Bookkeeping.
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  last_used_ip    TEXT,
  revoked_at      INTEGER
);
CREATE INDEX idx_integration_credentials_protocol_publicid
  ON integration_credentials(protocol, public_id) WHERE revoked_at IS NULL;
```

**Why store the scope as a Connect scope string verbatim:** the resolution path becomes trivially `connect.ParseScopes(row.scope)` → existing `RequireConnectScope` middleware. No second authorization vocabulary to maintain.

**Default scope on creation:** `files.write:<prefix>` for write-only sinks (the common case). The settings UI lets the user pick the prefix and (advanced) the action. Read-only credentials are valid but not wired into a UI flow in v1 — webhook senders never read.

**Why bcrypt the secret instead of storing a hash for fast lookup:** lookup is by `public_id` (webhook id, WebDAV username, S3 access key) which is a B-tree hit; bcrypt comparison happens once per request on a single row. Brute-force resistance matters more than 1ms of lookup latency for personal-server traffic.

**Webhook id source:** for webhook credentials, the URL embeds the credential id (`/webhook/<credential-id>/*path`). The `public_id` column holds this id (= `id`) so the lookup is a single index hit. The bearer token is the actual secret — anyone with the URL can attempt requests, but they need the token to succeed. (URL-only fallback `?token=…` matches the same secret against the same credential.)

## Surface 1 — HTTP webhook

### Wire shape

```
POST /webhook/<credential-id>/<path>
PUT  /webhook/<credential-id>/<path>     (alias for write-once-with-known-name idiom)
```

- Auth: `Authorization: Bearer <token>` preferred; `?token=<token>` accepted as fallback for senders that can't set headers (IFTTT, some shortcuts).
- Body: arbitrary bytes. `Content-Type` is preserved as the file's MIME type (best-effort detect if missing).
- Effective path: `<credential.scope-prefix>/<url-path>`. So a credential scoped to `/imports/fitness/apple-health` writing to `/webhook/<id>/2026/05/04/step-count.json` lands at `imports/fitness/apple-health/2026/05/04/step-count.json`.
- Response: `200 OK` with `{"path": "<resolved-path>", "size": N, "hash": "<sha256>"}`.

### Why prefix the URL with the scope, not require senders to send full paths

Senders generate paths from local context — Health Auto Export knows the date and metric, not the MyLifeDB folder layout. Prefix-baked-into-credential keeps them ignorant of MyLifeDB's directory structure and prevents path-escape bugs at the sender. The credential is the source of truth for *where* this app's data lives.

### Idempotency

`PUT` overwrites. `POST` overwrites. We do not generate unique filenames — senders must pick deterministic paths if they want idempotency. (Health Auto Export and the iOS app already do; ad-hoc senders that don't, get last-write-wins.)

If we later add an inbox-style "let the server pick a name" mode, that's a separate endpoint (`POST /webhook/<id>/inbox/`) with `Content-Disposition` filename hinting. Out of scope for v1.

### Reuse vs. parallel-implement

Body → `fs.Service.WriteFile()` — same path the existing `PUT /raw/*path` uses. No new file-write code path; the webhook handler is a thin auth shim plus a `WriteFile` call.

## Surface 2 — WebDAV

### Wire shape

```
/webdav/*    — full WebDAV namespace (PROPFIND, GET, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK)
```

- Auth: HTTP Basic. Username = `public_id` of a `webdav`-protocol credential; password = the app password.
- The credential's scope prefix becomes the WebDAV root the user sees. A credential scoped to `/imports/strava` makes `https://server/webdav/` look like just the contents of `imports/strava/`.

### Implementation

`golang.org/x/net/webdav` has a `Handler` that takes a `webdav.FileSystem` interface and a `webdav.LockSystem`. Use `webdav.Dir(<USER_DATA_DIR>/<scope-prefix>)` as the FS — the chroot is enforced by giving the WebDAV layer a filesystem rooted at the prefix, not by checking paths after the fact. This is the safest possible scope enforcement: the WebDAV implementation literally cannot see files outside the scope.

`webdav.NewMemLS()` for the lock system in v1 (locks are per-process, not durable across restarts). Acceptable for personal use.

### Compatibility caveats

- **iOS Files app**: requires HTTPS in practice (HTTP works in the simulator, fails on device with most servers). User must terminate TLS — document via reverse proxy.
- **Obsidian Remotely Save**: works over HTTP, uses path-based PROPFIND. Tested-known-working.
- **Finder Connect to Server**: works; macOS aggressively caches PROPFIND responses, can show stale views for ~30s.

### What WebDAV gives us that webhook doesn't

Two-way sync. WebDAV clients can read existing files (PROPFIND + GET), modify in place (LOCK + PUT + UNLOCK), and notice server-side changes (poll PROPFIND). That makes it the right surface for *editor*-style integrations (Obsidian, DEVONthink) where the third-party app treats MyLifeDB as its remote backing store.

## Surface 3 — S3-compatible

### Wire shape

```
PUT  /s3/<bucket>/<key>       — upload object
GET  /s3/<bucket>/<key>       — download object
HEAD /s3/<bucket>/<key>       — object metadata
DELETE /s3/<bucket>/<key>     — delete object
GET  /s3/<bucket>?...         — list objects (V2 list)
```

- Auth: AWS SigV4. Access Key ID = `public_id` of an `s3`-protocol credential; secret = the secret key.
- `<bucket>` is fixed to a single value per credential (the credential's scope prefix becomes the only bucket the credential can see). Multi-bucket support is out of scope for v1.
- Object keys are path-relative to the credential's scope prefix.

### Why a subset of S3, not embedded MinIO

MinIO-as-a-library was deprecated upstream; the supported path is running MinIO as a separate process. We do not want a second process. Implementing the ~10 S3 operations that backup tools actually use (the five above plus `ListBuckets`, `GetBucketLocation`) is well-understood and small — call it ~600 LOC.

SigV4 verification is the trickiest part; reference implementations exist (`github.com/aws/aws-sdk-go-v2/aws/signer/v4` has the request canonicalization rules; we compute the same and compare HMAC).

### What S3 gives us that webhook + WebDAV don't

- **rclone** / **restic** / **Duplicati** / **Arq** / **Kopia** — every major backup tool speaks S3. Treating MyLifeDB as a backup target unlocks the entire backup ecosystem.
- **Photo apps** — `PhotoSync`, `Immich uploaders`, etc. push to S3-compatible endpoints.
- **Multipart uploads** — for very large files (multi-GB exports, video). We will support multipart since the libraries above all use it for files >5 MB.

## Authorization plumbing

Common interface, three transports:

```go
// backend/integrations/credential.go

type Credential struct {
    ID           string
    Name         string
    Protocol     string         // "webhook" | "webdav" | "s3"
    PublicID     string
    Scope        connect.ScopeSet
    CreatedAt    time.Time
    LastUsedAt   *time.Time
    RevokedAt    *time.Time
}

type Store interface {
    Lookup(protocol, publicID string) (*Credential, []byte /*hashed secret*/, error)
    RecordUse(id, ip string) error
    Create(...) (*Credential, string /*plaintext secret, one-time*/, error)
    List() ([]*Credential, error)
    Revoke(id string) error
}
```

Each protocol handler:
1. Extracts `(publicID, presentedSecret)` from the wire (Bearer header, Basic header, SigV4 signature input).
2. Calls `store.Lookup(protocol, publicID)` to fetch credential + bcrypt hash.
3. Verifies the secret (bcrypt for webhook/webdav; SigV4 reconstruction for s3).
4. Sets `request.Context()` carrying `Credential.Scope` (same context key that Connect uses).
5. Calls `RequireConnectScope("files.write")` — the existing middleware reads the scope and checks the path.
6. Hands off to the `fs.Service.WriteFile` (webhook), `webdav.Handler` (webdav), or S3 op handler.

The Connect middleware needs a tiny generalization: today it pulls the scope from a Connect token, tomorrow it pulls from "whichever auth source ran". The cleanest seam is to attach `connect.ScopeSet` to the request context and have `RequireConnectScope` read from there regardless of where it came from. This lets the same middleware serve OAuth, webhook, WebDAV, and S3 — and any future fifth surface.

## Settings UX

One page client-side: **Settings → Integrations**. Server-side it pulls from two endpoints:

- `GET /api/connect/clients` — OAuth-registered apps (existing)
- `GET /api/connect/credentials` — manually-minted credentials (new)

Sketch:

```
Integrations
────────────────────────────────────────────────
OAuth apps                       [Register app]
─ Acme Notes (files.read:/notes, files.write:/notes/imports)
                              created Apr 2 · 12 calls today

Manual credentials               [+ New credential]
─ Webhook   "Health Auto Export"
            files.write:/imports/fitness/apple-health
            URL: https://you/webhook/abc123/<path>
            Token: hae_a3f2…  [reveal once]
            created May 4 · last used 12s ago · [revoke]
─ WebDAV    "iPad Obsidian"
            files.write:/notes
            URL: https://you/webdav/
            Username: obsidian-ipad
            Password: app_b4e1…  [reveal once]
            created Apr 28 · last used yesterday · [revoke]

Protocol surfaces                (toggles)
─ Webhook    [on]   /webhook/*
─ WebDAV     [off]  enable to expose /webdav/*
─ S3         [off]  enable to expose /s3/*
```

Per-credential settings: name, scope (path picker rooted at the FS tree, write/read action), and protocol. Created credentials show the secret **exactly once** at creation time — the user must copy it then; they cannot retrieve it later.

Per-protocol toggles gate whether the surface routes are mounted at all. Off → 404. This minimizes attack surface for users who only need one protocol.

## Public reachability

Documented, not bundled. A new docs page (`my-life-db-docs`, in `integrations/exposing-your-server.md`) walks through:

1. Cloudflare Tunnel (recommended — free, no port forwarding, free TLS)
2. Tailscale Funnel (good for users already in Tailscale)
3. Direct port forwarding + Let's Encrypt (advanced)

The docs page also explains that webhook needs a public URL but WebDAV and S3 work fine over LAN/Tailscale-only — most users will not need to expose to the open internet.

## Phased rollout

Each phase ships a working surface end-to-end (DB + backend + UI + docs) before the next starts.

### Phase 0 — Credential infrastructure (foundation)

**Scope:** the credentials table, the `Store`, the generalized scope-context plumbing, the `/api/connect/credentials` CRUD, and the Settings → Integrations page (read/list/create/revoke). No surface routes yet.

**Deliverables:**
- DB migration adding `integration_credentials`.
- `backend/integrations/` package: `Credential`, `Store` (SQLite-backed), bcrypt helpers.
- Generalize `RequireConnectScope` to read from a context key set by either Connect or integrations middleware.
- `/api/connect/credentials` GET (list), POST (create — returns secret once), DELETE (revoke).
- Frontend: Settings → Integrations page with empty state, create dialog, list view, revoke confirmation.
- Docs: `integrations/overview.md` explaining the model.

**Why this is the first phase:** all three surfaces consume this. Build once, plug in three times.

### Phase 1 — HTTP webhook

**Scope:** the `/webhook/<id>/*path` route, bearer-token + URL-token auth, write-only via `fs.WriteFile`.

**Deliverables:**
- `backend/api/webhook.go` with the handler.
- Auth helper that resolves bearer or `?token=` to a credential.
- Route mounted only when the protocol toggle is on (settings flag → conditional registration during route setup; toggling requires restart in v1, hot-reload later).
- Frontend: "Webhook" option in the create-credential dialog. Shows generated URL + token after creation.
- Docs: `integrations/webhook.md` with curl examples and a Health Auto Export setup walkthrough.

**Acceptance:** Health Auto Export pushing to a generated URL lands files in the scoped prefix.

### Phase 2 — WebDAV

**Scope:** mount `golang.org/x/net/webdav` at `/webdav/*`, Basic auth via integration credentials, scope-rooted FS.

**Deliverables:**
- `backend/api/webdav.go` wiring `webdav.Handler` with scope-rooted `webdav.Dir`.
- Per-request FS construction (cheap — `webdav.Dir` is just a string).
- In-memory `LockSystem`.
- Frontend: "WebDAV" option in create-credential dialog. Shows mount URL + username + password.
- Docs: `integrations/webdav.md` with iOS Files, Obsidian Remotely Save, Finder Connect setup.

**Acceptance:** Obsidian Remotely Save round-trips a file (write from device, read back from web UI).

### Phase 3 — S3-compatible

**Scope:** subset of S3 API at `/s3/<bucket>/*`, SigV4 auth via integration credentials, scope-rooted bucket.

**Deliverables:**
- `backend/api/s3.go` implementing GET/PUT/HEAD/DELETE object, V2 list, multipart upload.
- SigV4 verifier (canonicalize → HMAC-SHA256 → constant-time compare).
- Frontend: "S3" option in create-credential dialog. Shows endpoint, access key, secret, bucket name.
- Docs: `integrations/s3.md` with rclone, restic, Duplicati setup.

**Acceptance:** rclone `sync` and restic `backup` to the endpoint succeed and round-trip.

### Phase 4 — Polish

- Per-credential rate limiting (token bucket per credential id).
- "Last used" timestamp + IP visible in settings (already in schema; add to UI).
- Optional: webhook payload replay log, gzipped, N-day retention, opt-in per credential.
- Live toggle of protocol surfaces without restart (rebuild router on toggle change — gin supports route reloading via swap).

## Open questions

These are worth deciding before Phase 0 starts but don't block the design.

1. **Credential id format.** UUID v4 is fine but ugly in URLs. Short prefixed ids (`whk_a3f2x9`, `wdv_b4e1y2`, `s3k_c5f3z8`) are nicer in docs and logs. **Lean: prefixed-short.**
2. **Plaintext secret length / format.** Current Connect uses 32-byte URL-safe base64. Match that for webhook bearer tokens. WebDAV passwords human-readable-ish (24 chars, mixed case + digits, no symbols that confuse copy/paste). S3 follows AWS conventions (20-char access key, 40-char secret).
3. **Default scope path picker root.** Today there's no "browse the FS" component for path selection. The dialog will start with a free-text path field plus a hint ("e.g. `/imports/fitness/apple-health`"). A real picker can come later.
4. **Audit log surface.** Connect already has `/api/connect/clients/:id/audit`. Mirror with `/api/connect/credentials/:id/audit` in Phase 4 — same shape (per-call rows: timestamp, IP, method, path, status).
