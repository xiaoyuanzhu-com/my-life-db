/**
 * Settings → Connected Apps tab.
 *
 * Renders the list of third-party apps that have ever requested authorization
 * to this MyLifeDB instance. For each app:
 *   - shows the (self-declared) name + icon, scopes granted, last-used time;
 *   - lets the owner revoke (cascades grants/codes/tokens via the backend);
 *   - opens an audit panel showing the most recent gated requests.
 *
 * Backed by:
 *   GET    /api/connect/clients
 *   DELETE /api/connect/clients/:id
 *   GET    /api/connect/clients/:id/audit
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Loader2, Trash2, ChevronRight, ShieldCheck, ShieldAlert } from "lucide-react";
import { api } from "~/lib/api";

interface ConnectClient {
  id: string;
  name: string;
  iconUrl: string;
  verified: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  scopes: string[] | null;
  grantedAt: number | null;
  lastUsedAt: number | null;
}

interface AuditEntry {
  id: number;
  ts: number;
  method: string;
  path: string;
  status: number;
  scope: string;
  clientId: string;
}

function fmtTs(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

export function ConnectedAppsTab() {
  const { t } = useTranslation("settings");
  const [clients, setClients] = useState<ConnectClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openAudit, setOpenAudit] = useState<string | null>(null);
  const [audit, setAudit] = useState<Record<string, AuditEntry[]>>({});

  const reload = useCallback(async () => {
    try {
      const res = await api.get("/api/connect/clients");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setClients(json.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const revoke = useCallback(
    async (clientId: string, name: string) => {
      const ok = window.confirm(
        t(
          "connect.confirmRevoke",
          'Revoke access for "{{name}}"? Any active sessions will be terminated.',
          { name },
        ),
      );
      if (!ok) return;
      try {
        const res = await api.delete(`/api/connect/clients/${encodeURIComponent(clientId)}`);
        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [reload, t],
  );

  const toggleAudit = useCallback(
    async (clientId: string) => {
      if (openAudit === clientId) {
        setOpenAudit(null);
        return;
      }
      setOpenAudit(clientId);
      if (!audit[clientId]) {
        try {
          const res = await api.get(
            `/api/connect/clients/${encodeURIComponent(clientId)}/audit?limit=50`,
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          setAudit((prev) => ({ ...prev, [clientId]: json.data || [] }));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [audit, openAudit],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("connect.title", "Connected Apps")}</CardTitle>
        <p className="text-sm text-muted-foreground mt-2">
          {t(
            "connect.subtitle",
            "Third-party apps that you have authorized to access your MyLifeDB. Revoking removes all access; the app will need to ask again.",
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="text-sm text-destructive bg-destructive/10 rounded-md p-2">
            {error}
          </div>
        )}

        {clients === null ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : clients.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            {t("connect.empty", "No apps have requested access yet.")}
          </p>
        ) : (
          <ul className="space-y-3">
            {clients.map((c) => (
              <li key={c.id} className="rounded-lg bg-muted/40 p-3">
                <div className="flex items-start gap-3">
                  {c.iconUrl ? (
                    <img
                      src={c.iconUrl}
                      alt=""
                      className="h-10 w-10 rounded-md object-cover bg-muted"
                    />
                  ) : (
                    <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center text-muted-foreground">
                      {c.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      {c.verified ? (
                        <ShieldCheck className="h-4 w-4 text-primary" />
                      ) : (
                        <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{c.id}</p>
                    {c.scopes && c.scopes.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {c.scopes.map((s) => (
                          <code
                            key={s}
                            className="text-xs rounded bg-background px-1.5 py-0.5"
                          >
                            {s}
                          </code>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t("connect.noGrant", "No grant — has only requested access.")}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("connect.granted", "Granted")}: {fmtTs(c.grantedAt)} ·{" "}
                      {t("connect.lastUsed", "Last used")}: {fmtTs(c.lastUsedAt)}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleAudit(c.id)}
                      title={t("connect.viewActivity", "View activity")}
                    >
                      <ChevronRight
                        className={`h-4 w-4 transition-transform ${openAudit === c.id ? "rotate-90" : ""}`}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => revoke(c.id, c.name)}
                      title={t("connect.revoke", "Revoke")}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>

                {openAudit === c.id && (
                  <div className="mt-3 border-t pt-3">
                    {audit[c.id] === undefined ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : audit[c.id].length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("connect.noActivity", "No activity recorded yet.")}
                      </p>
                    ) : (
                      <ul className="space-y-1 text-xs font-mono">
                        {audit[c.id].map((row) => (
                          <li
                            key={row.id}
                            className="flex items-center gap-2 text-muted-foreground"
                          >
                            <span className="w-32 shrink-0">{fmtTs(row.ts)}</span>
                            <span
                              className={`w-12 shrink-0 ${row.status >= 400 ? "text-destructive" : ""}`}
                            >
                              {row.status}
                            </span>
                            <span className="w-16 shrink-0">{row.method}</span>
                            <span className="truncate flex-1">{row.path}</span>
                            {row.scope && <span className="shrink-0">{row.scope}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
