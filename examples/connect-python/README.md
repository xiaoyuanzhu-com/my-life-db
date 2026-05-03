# MyLifeDB Connect — Python Reference Client

A small, dependency-light Python script that demonstrates the full
[MyLifeDB Connect](../../docs/) third-party-app authorization flow:

1. Discovery via `/.well-known/oauth-authorization-server`
2. PKCE (S256) authorization-code grant against `/connect/authorize` +
   `/connect/token`
3. A handful of authenticated `/api/data/*` calls that exercise the
   per-route scope gates (folder create, file upload, metadata read,
   SSE event stream, delete)
4. Token revocation at `/connect/revoke`

This is the canonical reference for what a third-party app integrating
with a user's MyLifeDB instance has to do. If you are writing a client
in another language, mirror the steps in `connect_client.py`.

## Requirements

- Python 3.10+
- `requests` (`pip install requests`)
- A running MyLifeDB instance (default: `http://localhost:12345`)
- Owner is logged in to the instance in their browser (so the consent
  screen can render — Connect approval requires an owner-authenticated
  session)

## Usage

```bash
cd examples/connect-python
pip install requests
python connect_client.py
```

A browser window opens at the consent screen. Approve, and the script
will print each step:

```
== Discovering http://localhost:12345 ==
  authz endpoint: http://localhost:12345/connect/authorize
  token endpoint: http://localhost:12345/connect/token
  ...

== Requesting consent for: files.read:/ files.write:/inbox ==

Open this URL to grant consent (browser launching):
  http://localhost:12345/connect/authorize?response_type=code&...

  received code (first 12 chars): xR8tKa1mNu2v...
  granted scope: files.read:/ files.write:/inbox
  access token expires in 3600s

== GET /api/data/root ==
  root has 7 top-level entries

== POST /api/data/folders → inbox/connect-python-demo ==
  created: inbox/connect-python-demo

== PUT /api/data/uploads/simple/inbox/connect-python-demo/hello.txt ==
  upload result: [{'path': 'inbox/connect-python-demo/hello.txt', 'status': 'created'}]
...
```

### Common flags

| Flag              | Default                              | Notes |
| ----------------- | ------------------------------------ | ----- |
| `--base-url`      | `http://localhost:12345`             | Or set `MLDB_BASE_URL` env var. |
| `--client-id`     | `connect-python-demo`                | Any unique string identifying your app. |
| `--app-name`      | `Python Reference Client`            | Display name shown on the consent screen. |
| `--scope`         | `files.read:/ files.write:/inbox`    | Space-separated capabilities. |
| `--port`          | `8765`                               | Local loopback port for the redirect. |
| `--demo-folder`   | `connect-python-demo`                | Subfolder created under `/inbox`. |
| `--no-cleanup`    | (off)                                | Skip deleting the demo file/folder at the end. |
| `--no-events`     | (off)                                | Skip the SSE event stream sample. |

## Scope shape primer

Scopes are space-separated `<family>:<path>` pairs:

- `files.read:/`               — read everything
- `files.read:/notes`          — read `/notes` and anything under it
- `files.write:/inbox`         — write to `/inbox` and anything under it
- `files.read:/ files.write:/` — full read + write

Path semantics are prefix-containment: `files.read:/notes` covers
`/notes/2026/foo.md` but not `/journal/secret.md`. The root scope `/`
covers everything in that family.

## What this proves

- Discovery works and returns the canonical endpoints.
- The authorization-code + PKCE flow round-trips correctly.
- The granted scopes gate `/api/data/*` exactly as documented:
  - `files.read:/` is required for `GET /api/data/root`,
    `GET /api/data/tree`, `GET /api/data/files/...`, and the SSE stream
    at `GET /api/data/events`.
  - `files.write:/inbox` is required for `POST /api/data/folders`
    (when the resolved folder is under `/inbox`),
    `PUT /api/data/uploads/simple/inbox/...`, and `DELETE` calls under
    `/inbox`.
- The SSE stream filters events server-side: a token scoped only to
  `/inbox` will never see events for files under `/notes`.

## Troubleshooting

- **The browser shows the login page, not the consent screen.** The
  owner is not signed in to the instance. Sign in first, then re-run.
- **`HTTPError 401 Unauthorized` on `/api/data/...`.** The access token
  expired (default TTL: 1 hour). Either re-run the script, or call
  `client.refresh()` from your own code.
- **`HTTPError 403 Forbidden`.** Your token's scope does not cover the
  path you tried to touch. Re-run with a wider `--scope`, or change the
  path you are accessing.
- **Browser does not open automatically.** The script prints the
  authorization URL — copy and paste it into a browser manually.
