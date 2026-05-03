#!/usr/bin/env python3
"""
MyLifeDB Connect — Python reference client.

Demonstrates the full OAuth 2.1 PKCE flow against a running MyLifeDB
instance and exercises a handful of /api/data/* endpoints to prove the
scope gates work.

Flow:
  1. Discover endpoints from /.well-known/oauth-authorization-server.
  2. Generate PKCE pair (verifier + S256 challenge).
  3. Spin up a localhost loopback HTTP server on :8765 to catch the
     redirect.
  4. Open the browser at /connect/authorize with our params.
  5. User logs in (if needed) and approves the consent screen — the SPA
     redirects back to http://127.0.0.1:8765/cb?code=...&state=...
  6. Exchange the code at /connect/token (form-encoded, with
     code_verifier — no client secret).
  7. Use the access token as `Authorization: Bearer <tok>` against
     /api/data/*.

Requires: requests (pip install requests). Stdlib otherwise.

Usage:
    python connect_client.py --base-url http://localhost:12345 \\
        --scope "files.read:/ files.write:/inbox"

Run with --help for all options.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import socketserver
import sys
import threading
import time
import urllib.parse
import webbrowser
from dataclasses import dataclass
from typing import Optional

import requests


# ---------------------------------------------------------------------------
# PKCE helpers
# ---------------------------------------------------------------------------

def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def make_pkce() -> tuple[str, str]:
    """Return (code_verifier, code_challenge) — S256."""
    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


# ---------------------------------------------------------------------------
# Loopback server to catch the OAuth redirect
# ---------------------------------------------------------------------------

@dataclass
class CallbackResult:
    code: Optional[str] = None
    state: Optional[str] = None
    error: Optional[str] = None
    error_description: Optional[str] = None


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    # The container sets `result` and `expected_state` on the class.
    result: CallbackResult = None  # type: ignore
    expected_state: str = ""
    done_event: threading.Event = None  # type: ignore

    # Silence the noisy default access log.
    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/cb"):
            self.send_response(404)
            self.end_headers()
            return

        params = urllib.parse.parse_qs(parsed.query)
        code = params.get("code", [None])[0]
        state = params.get("state", [None])[0]
        err = params.get("error", [None])[0]
        err_desc = params.get("error_description", [None])[0]

        type(self).result = CallbackResult(
            code=code, state=state, error=err, error_description=err_desc
        )
        body = (
            "<!doctype html><meta charset=utf-8>"
            "<title>MyLifeDB Connect</title>"
            "<body style='font-family:system-ui;padding:2em'>"
            "<h2>You can close this tab.</h2>"
            "<p>The Python reference client received the callback.</p>"
            "</body>"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))
        type(self).done_event.set()


def wait_for_callback(port: int, expected_state: str, timeout: float = 300.0) -> CallbackResult:
    done = threading.Event()
    _CallbackHandler.result = CallbackResult()
    _CallbackHandler.expected_state = expected_state
    _CallbackHandler.done_event = done

    server = socketserver.TCPServer(("127.0.0.1", port), _CallbackHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        ok = done.wait(timeout=timeout)
        if not ok:
            raise TimeoutError(f"no OAuth callback within {timeout}s")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)

    return _CallbackHandler.result


# ---------------------------------------------------------------------------
# Connect client
# ---------------------------------------------------------------------------

@dataclass
class TokenSet:
    access_token: str
    refresh_token: str
    expires_in: int
    refresh_expires_in: int
    scope: str


class ConnectClient:
    def __init__(self, base_url: str, client_id: str, app_name: str,
                 redirect_uri: str):
        self.base_url = base_url.rstrip("/")
        self.client_id = client_id
        self.app_name = app_name
        self.redirect_uri = redirect_uri
        self._tokens: Optional[TokenSet] = None
        # Filled by discover().
        self.authz_endpoint: Optional[str] = None
        self.token_endpoint: Optional[str] = None
        self.revocation_endpoint: Optional[str] = None
        self.scopes_supported: list[str] = []

    def discover(self) -> None:
        url = f"{self.base_url}/.well-known/oauth-authorization-server"
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        meta = r.json()
        self.authz_endpoint = meta["authorization_endpoint"]
        self.token_endpoint = meta["token_endpoint"]
        self.revocation_endpoint = meta["revocation_endpoint"]
        self.scopes_supported = meta.get("scopes_supported", [])
        # Re-anchor on the issuer the server reports so behind-proxy setups
        # work correctly.
        if "issuer" in meta:
            self.base_url = meta["issuer"].rstrip("/")
        print(f"  authz endpoint: {self.authz_endpoint}")
        print(f"  token endpoint: {self.token_endpoint}")
        print(f"  scopes supported: {', '.join(self.scopes_supported)}")

    def authorize_interactive(self, scope: str, port: int) -> None:
        """Open the consent flow in a browser, wait for the redirect, exchange code."""
        if not self.authz_endpoint:
            raise RuntimeError("call discover() first")

        verifier, challenge = make_pkce()
        state = b64url(secrets.token_bytes(16))

        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": scope,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "app_name": self.app_name,
        }
        url = f"{self.authz_endpoint}?{urllib.parse.urlencode(params)}"
        print(f"\nOpen this URL to grant consent (browser launching):\n  {url}\n")
        try:
            webbrowser.open(url)
        except Exception:
            pass

        result = wait_for_callback(port, state)
        if result.error:
            raise RuntimeError(
                f"authorization denied: {result.error} ({result.error_description})"
            )
        if not result.code or result.state != state:
            raise RuntimeError(
                f"bad callback (state mismatch or no code): got state={result.state!r}"
            )
        print(f"  received code (first 12 chars): {result.code[:12]}...")

        # Exchange code for tokens.
        body = {
            "grant_type": "authorization_code",
            "code": result.code,
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "code_verifier": verifier,
        }
        r = requests.post(self.token_endpoint, data=body, timeout=10)
        if r.status_code != 200:
            raise RuntimeError(f"token exchange failed: {r.status_code} {r.text}")
        tok = r.json()
        self._tokens = TokenSet(
            access_token=tok["access_token"],
            refresh_token=tok["refresh_token"],
            expires_in=int(tok["expires_in"]),
            refresh_expires_in=int(tok.get("refresh_expires_in", 0)),
            scope=tok.get("scope", ""),
        )
        print(f"  granted scope: {self._tokens.scope}")
        print(f"  access token expires in {self._tokens.expires_in}s")

    def refresh(self) -> None:
        if not self._tokens:
            raise RuntimeError("not authorized yet")
        body = {
            "grant_type": "refresh_token",
            "refresh_token": self._tokens.refresh_token,
            "client_id": self.client_id,
        }
        r = requests.post(self.token_endpoint, data=body, timeout=10)
        if r.status_code != 200:
            raise RuntimeError(f"refresh failed: {r.status_code} {r.text}")
        tok = r.json()
        self._tokens = TokenSet(
            access_token=tok["access_token"],
            refresh_token=tok["refresh_token"],
            expires_in=int(tok["expires_in"]),
            refresh_expires_in=int(tok.get("refresh_expires_in", 0)),
            scope=tok.get("scope", ""),
        )

    def revoke(self) -> None:
        if not self._tokens or not self.revocation_endpoint:
            return
        # Revoking the refresh kills the whole chain (access + future refreshes).
        requests.post(
            self.revocation_endpoint,
            data={"token": self._tokens.refresh_token,
                  "token_type_hint": "refresh_token"},
            timeout=10,
        )
        self._tokens = None

    # ---- API helpers -----------------------------------------------------

    def _auth_headers(self) -> dict[str, str]:
        if not self._tokens:
            raise RuntimeError("not authorized yet")
        return {"Authorization": f"Bearer {self._tokens.access_token}"}

    def get_root(self) -> dict:
        r = requests.get(
            f"{self.base_url}/api/data/root",
            headers=self._auth_headers(), timeout=10,
        )
        r.raise_for_status()
        return r.json()

    def list_tree(self, path: str = "") -> dict:
        r = requests.get(
            f"{self.base_url}/api/data/tree",
            params={"path": path},
            headers=self._auth_headers(), timeout=10,
        )
        r.raise_for_status()
        return r.json()

    def create_folder(self, parent: str, name: str) -> dict:
        r = requests.post(
            f"{self.base_url}/api/data/folders",
            json={"parent": parent, "name": name},
            headers=self._auth_headers(), timeout=10,
        )
        r.raise_for_status()
        return r.json()

    def simple_upload(self, path: str, content: bytes,
                      mime_type: str = "text/plain") -> dict:
        # PUT /api/data/uploads/simple/*path
        r = requests.put(
            f"{self.base_url}/api/data/uploads/simple/{path.lstrip('/')}",
            data=content,
            headers={**self._auth_headers(), "Content-Type": mime_type},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()

    def get_file(self, path: str) -> dict:
        r = requests.get(
            f"{self.base_url}/api/data/files/{path.lstrip('/')}",
            headers=self._auth_headers(), timeout=10,
        )
        r.raise_for_status()
        return r.json()

    def delete_file(self, path: str) -> None:
        r = requests.delete(
            f"{self.base_url}/api/data/files/{path.lstrip('/')}",
            headers=self._auth_headers(), timeout=10,
        )
        r.raise_for_status()

    def stream_events(self, max_seconds: float = 5.0) -> list[dict]:
        """Read SSE events for at most max_seconds and return what we got.

        The stream is filtered server-side by our token's files.read scope.
        """
        events: list[dict] = []
        deadline = time.time() + max_seconds
        with requests.get(
            f"{self.base_url}/api/data/events",
            headers=self._auth_headers(),
            stream=True, timeout=max_seconds + 5,
        ) as r:
            r.raise_for_status()
            buf: list[str] = []
            for raw in r.iter_lines(decode_unicode=True):
                if raw is None:
                    continue
                if time.time() > deadline:
                    break
                if raw == "":
                    if buf:
                        events.append({"raw": "\n".join(buf)})
                        buf = []
                    continue
                if raw.startswith("data: "):
                    payload = raw[len("data: "):]
                    try:
                        events.append(json.loads(payload))
                    except json.JSONDecodeError:
                        events.append({"raw": payload})
                # heartbeat lines start with ":" — skip silently.
        return events


# ---------------------------------------------------------------------------
# Demo entry point
# ---------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(description="MyLifeDB Connect — Python reference client demo")
    p.add_argument("--base-url", default=os.environ.get("MLDB_BASE_URL", "http://localhost:12345"),
                   help="MyLifeDB instance base URL (default: http://localhost:12345 or $MLDB_BASE_URL)")
    p.add_argument("--client-id", default="connect-python-demo",
                   help="OAuth client_id (any unique string identifying this app)")
    p.add_argument("--app-name", default="Python Reference Client",
                   help="Self-declared display name shown on the consent screen")
    p.add_argument("--port", type=int, default=8765,
                   help="Local port for the loopback redirect server")
    p.add_argument("--scope", default="files.read:/ files.write:/inbox",
                   help="Space-separated capabilities to request")
    p.add_argument("--demo-folder", default="connect-python-demo",
                   help="Subfolder inside /inbox to create + drop a sample file in")
    p.add_argument("--no-cleanup", action="store_true",
                   help="Skip deleting the demo file/folder at the end")
    p.add_argument("--no-events", action="store_true",
                   help="Skip the SSE event stream sample")
    args = p.parse_args()

    redirect_uri = f"http://127.0.0.1:{args.port}/cb"

    client = ConnectClient(
        base_url=args.base_url,
        client_id=args.client_id,
        app_name=args.app_name,
        redirect_uri=redirect_uri,
    )

    print(f"== Discovering {args.base_url} ==")
    client.discover()

    print(f"\n== Requesting consent for: {args.scope} ==")
    client.authorize_interactive(scope=args.scope, port=args.port)

    print("\n== GET /api/data/root ==")
    root = client.get_root()
    print(f"  root has {len(root.get('files', []))} top-level entries")

    folder_path = f"inbox/{args.demo_folder}"
    sample_path = f"{folder_path}/hello.txt"
    sample_body = b"hello from the Python reference client\n"

    print(f"\n== POST /api/data/folders → {folder_path} ==")
    try:
        out = client.create_folder(parent="inbox", name=args.demo_folder)
        print(f"  created: {out.get('path')}")
    except requests.HTTPError as e:
        # 409 is fine — folder already exists from a prior demo run.
        if e.response is not None and e.response.status_code == 409:
            print(f"  already exists (409); reusing")
        else:
            raise

    print(f"\n== PUT /api/data/uploads/simple/{sample_path} ==")
    out = client.simple_upload(sample_path, sample_body, mime_type="text/plain")
    print(f"  upload result: {out.get('results')}")

    print(f"\n== GET /api/data/files/{sample_path} ==")
    info = client.get_file(sample_path)
    print(f"  size={info.get('size')} mime={info.get('mimeType')} hash={info.get('hash')}")

    if not args.no_events:
        print("\n== GET /api/data/events (SSE; reading 3s of stream) ==")
        events = client.stream_events(max_seconds=3.0)
        if not events:
            print("  no events received in window")
        for ev in events[:5]:
            print(f"  event: {ev}")

    if not args.no_cleanup:
        print(f"\n== DELETE /api/data/files/{sample_path} ==")
        client.delete_file(sample_path)
        print("  deleted")
        print(f"\n== DELETE /api/data/files/{folder_path} ==")
        client.delete_file(folder_path)
        print("  deleted")

    print("\n== POST /connect/revoke (cleanup) ==")
    client.revoke()
    print("  tokens revoked\n")
    print("Done.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        sys.exit(130)
    except requests.HTTPError as e:
        print(f"\nHTTP error: {e}\nresponse body: {e.response.text if e.response else ''}",
              file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"\nerror: {e}", file=sys.stderr)
        sys.exit(1)
