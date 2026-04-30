/**
 * MyLifeDB Connect — third-party consent screen.
 *
 * Path: /connect/authorize?<oauth params>
 *
 * Flow:
 *   1) Read OAuth-style query params (response_type, client_id, redirect_uri,
 *      scope, state, code_challenge, code_challenge_method, app_name, app_icon).
 *   2) Call GET /api/connect/authorize/preview to validate them server-side
 *      and resolve the client/grant metadata. The same call upserts the
 *      client row, so the user never sees an unknown client.
 *   3) Render: app card + "wants permission to" scope list, with an Approve
 *      and a Deny button.
 *   4) On submit: POST /api/connect/consent with the same params + approve flag.
 *      The server returns { redirectTo } and we hard-navigate to it.
 *
 * The consent decision is what binds the client to the owner's instance —
 * there is no pre-registration step. The "verified" flag on the client is
 * reserved for a future trust layer; for now we render every approved app
 * the same way.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { ShieldCheck, Loader2, AlertTriangle } from "lucide-react";
import { api } from "~/lib/api";

interface PreviewResponse {
  data: {
    client: { id: string; name: string; iconUrl: string; verified: boolean };
    requestedScopes: string[];
    grantedScopes: string[];
    newScopes: string[];
    canSilentApprove: boolean;
    redirectUri: string;
  };
}

interface ConsentResponse {
  data: { redirectTo: string };
}

// allParams reads every Connect-relevant query param off the current URL.
function allParams(): Record<string, string> {
  const u = new URL(window.location.href);
  const out: Record<string, string> = {};
  for (const k of [
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
    "app_name",
    "app_icon",
  ]) {
    const v = u.searchParams.get(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

// humanizeScope turns "files.read:/journal" into a human-readable phrase.
// Keep this dumb — the permission text is what the user actually consents to,
// so it must be obvious.
function humanizeScope(scope: string): { verb: string; target: string; destructive: boolean } {
  const [family, path = ""] = scope.split(":");
  const target = path === "/" ? "everything" : path || "";
  let verb = family;
  let destructive = false;
  if (family === "files.read") verb = "Read files in";
  else if (family === "files.write") {
    verb = "Write and modify files in";
    destructive = path === "/";
  }
  return { verb, target, destructive };
}

export default function ConnectAuthorize() {
  const { t } = useTranslation("settings");
  const [preview, setPreview] = useState<PreviewResponse["data"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const params = useMemo(() => allParams(), []);
  const queryString = useMemo(() => new URLSearchParams(params).toString(), [params]);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get(`/api/connect/authorize/preview?${queryString}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error?.message || `HTTP ${res.status}`);
        }
        const json: PreviewResponse = await res.json();
        setPreview(json.data);

        // Optional silent approval: if the request is a strict subset of an
        // existing grant, skip the consent screen entirely. Disabled for
        // now — explicit re-prompt is friendlier when re-auth is rare.
        // (Remove the `false &&` to enable.)
        if (false && json.data.canSilentApprove) {
          await submit(true);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(approve: boolean) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post("/api/connect/consent", { ...params, approve });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `HTTP ${res.status}`);
      }
      const json: ConsentResponse = await res.json();
      // Hard navigate to the third-party redirect URI. Don't use react-router
      // navigate — the destination is not part of this SPA.
      window.location.assign(json.data.redirectTo);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto pt-16 px-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              {t("connect.error.title", "Authorization request rejected")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="max-w-md mx-auto pt-16 px-4 flex justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { client, requestedScopes, grantedScopes, newScopes } = preview;
  const isReturning = grantedScopes.length > 0;
  const onlyNewMatters = isReturning && newScopes.length > 0;

  return (
    <div className="max-w-md mx-auto pt-16 px-4 mb-20">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            {client.iconUrl ? (
              // eslint-disable-next-line jsx-a11y/img-redundant-alt
              <img
                src={client.iconUrl}
                alt={`${client.name} icon`}
                className="h-12 w-12 rounded-lg bg-muted object-cover"
              />
            ) : (
              <div className="h-12 w-12 rounded-lg bg-muted flex items-center justify-center text-muted-foreground">
                {client.name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                {client.name}
                {client.verified && <ShieldCheck className="h-4 w-4 text-primary" />}
              </CardTitle>
              <p className="text-xs text-muted-foreground truncate">{client.id}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">
            {onlyNewMatters
              ? t("connect.body.additional", "{{name}} is requesting additional access to your MyLifeDB:", { name: client.name })
              : t("connect.body.first", "{{name}} is requesting access to your MyLifeDB:", { name: client.name })}
          </p>

          <ul className="space-y-2">
            {(onlyNewMatters ? newScopes : requestedScopes).map((s) => {
              const { verb, target, destructive } = humanizeScope(s);
              return (
                <li
                  key={s}
                  className={`flex items-start gap-2 rounded-md p-2 ${destructive ? "bg-destructive/10 border border-destructive/30" : "bg-muted/50"}`}
                >
                  <div className="mt-0.5 h-2 w-2 rounded-full bg-foreground/50 shrink-0" />
                  <div className="text-sm">
                    <span className="font-medium">{verb}</span>{" "}
                    <code className="rounded bg-background px-1 py-0.5 text-xs">{target}</code>
                  </div>
                </li>
              );
            })}
          </ul>

          {onlyNewMatters && (
            <p className="text-xs text-muted-foreground">
              {t(
                "connect.body.alreadyGranted",
                "Already granted: {{scopes}}",
                { scopes: grantedScopes.join(", ") },
              )}
            </p>
          )}

          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => submit(false)} disabled={submitting}>
              {t("connect.deny", "Deny")}
            </Button>
            <Button className="flex-1" onClick={() => submit(true)} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t("connect.allow", "Allow")}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            {t(
              "connect.body.afterClick",
              "You'll be redirected back to {{name}} after you decide.",
              { name: client.name },
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
