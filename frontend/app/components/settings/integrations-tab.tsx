/**
 * Settings → Integrations tab.
 *
 * Owner-only management of long-lived credentials for non-OAuth ingestion
 * surfaces (HTTP webhook, WebDAV, S3-compatible). Sister to the Connected
 * Apps tab — same conceptual category (third-party access management),
 * different auth model.
 *
 * For each credential:
 *   - shows protocol badge + name + scope + secret-prefix + last-used time
 *   - lets the owner revoke (soft-delete; the credential stops working immediately)
 *
 * The "Create" dialog mints a new credential and reveals the raw secret
 * exactly once — captured-on-screen, never recoverable.
 *
 * Backed by:
 *   GET    /api/connect/credentials
 *   POST   /api/connect/credentials  { name, protocol, scope }
 *   DELETE /api/connect/credentials/:id
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Loader2,
  Plus,
  Trash2,
  Webhook,
  FolderOpen,
  Database,
  Copy,
  Check,
  History,
} from "lucide-react";
import { api } from "~/lib/api";
import { useSettingsContext } from "~/components/settings/settings-context";

type Protocol = "webhook" | "webdav" | "s3";

interface Credential {
  id: string;
  name: string;
  protocol: Protocol;
  publicId: string;
  secretPrefix: string;
  scope: string;
  createdAt: number;
  lastUsedAt: number | null;
  lastUsedIp?: string;
}

interface IssuedCredential extends Credential {
  secret: string;
}

const PROTOCOL_META: Record<Protocol, { label: string; icon: typeof Webhook }> = {
  webhook: { label: "HTTP webhook", icon: Webhook },
  webdav: { label: "WebDAV", icon: FolderOpen },
  s3: { label: "S3-compatible", icon: Database },
};

function fmtTs(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

export function IntegrationsTab() {
  const { t } = useTranslation("settings");
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [auditOpen, setAuditOpen] = useState<Credential | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await api.get("/api/connect/credentials");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setCredentials(json.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const revoke = useCallback(
    async (id: string, name: string) => {
      const ok = window.confirm(
        t(
          "integrations.confirmRevoke",
          'Revoke credential "{{name}}"? Any apps using it will stop working immediately.',
          { name },
        ),
      );
      if (!ok) return;
      try {
        const res = await api.delete(`/api/connect/credentials/${encodeURIComponent(id)}`);
        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [reload, t],
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>{t("integrations.title", "Integrations")}</CardTitle>
            <p className="text-sm text-muted-foreground mt-2">
              {t(
                "integrations.subtitle",
                "Long-lived credentials for apps that push data to MyLifeDB over webhook, WebDAV, or S3. Each credential is bound to one folder.",
              )}
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-2 shrink-0">
            <Plus className="h-4 w-4" />
            {t("integrations.new", "New")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="text-sm text-destructive bg-destructive/10 rounded-md p-2">
            {error}
          </div>
        )}

        {credentials === null ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            {t("integrations.empty", "No credentials yet. Click \u201CNew\u201D to mint one.")}
          </p>
        ) : (
          <ul className="space-y-3">
            {credentials.map((c) => {
              const meta = PROTOCOL_META[c.protocol];
              const Icon = meta.icon;
              return (
                <li key={c.id} className="rounded-lg bg-muted/40 p-3">
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center text-muted-foreground shrink-0">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{c.name}</span>
                        <span className="text-xs rounded bg-background px-1.5 py-0.5">
                          {meta.label}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate font-mono mt-1">
                        {c.id}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <code className="text-xs rounded bg-background px-1.5 py-0.5">
                          {c.scope}
                        </code>
                        <code className="text-xs rounded bg-background px-1.5 py-0.5 text-muted-foreground">
                          {c.secretPrefix}…
                        </code>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t("integrations.created", "Created")}: {fmtTs(c.createdAt)} ·{" "}
                        {t("integrations.lastUsed", "Last used")}: {fmtTs(c.lastUsedAt)}
                        {c.lastUsedIp && (
                          <>
                            {" "}
                            <span className="text-muted-foreground/80">
                              · {t("integrations.fromIp", "from {{ip}}", { ip: c.lastUsedIp })}
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setAuditOpen(c)}
                      title={t("integrations.history", "History")}
                    >
                      <History className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => revoke(c.id, c.name)}
                      title={t("integrations.revoke", "Revoke")}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <CreateCredentialDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(c) => {
          setIssued(c);
          setCreateOpen(false);
          void reload();
        }}
      />

      <SecretRevealDialog issued={issued} onClose={() => setIssued(null)} />

      <AuditDialog credential={auditOpen} onClose={() => setAuditOpen(null)} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Audit drawer
// ---------------------------------------------------------------------------

interface AuditRow {
  id: number;
  ts: number;
  ip?: string;
  method: string;
  path: string;
  status: number;
}

function AuditDialog({
  credential,
  onClose,
}: {
  credential: Credential | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!credential) {
      setRows(null);
      setError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setRows(null);
      setError(null);
      try {
        const res = await api.get(
          `/api/connect/credentials/${encodeURIComponent(credential.id)}/audit?limit=100`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setRows(json.data || []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [credential]);

  if (!credential) return null;

  return (
    <Dialog open={!!credential} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("integrations.audit.title", "Recent requests")}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">{credential.name}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 rounded-md p-2">
              {error}
            </div>
          )}
          {rows === null && !error && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {rows !== null && rows.length === 0 && !error && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {t("integrations.audit.empty", "No requests yet.")}
            </p>
          )}
          {rows !== null && rows.length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1.5 pr-2 font-normal">
                    {t("integrations.audit.time", "Time")}
                  </th>
                  <th className="py-1.5 pr-2 font-normal">
                    {t("integrations.audit.method", "Method")}
                  </th>
                  <th className="py-1.5 pr-2 font-normal">
                    {t("integrations.audit.path", "Path")}
                  </th>
                  <th className="py-1.5 pr-2 font-normal">
                    {t("integrations.audit.status", "Status")}
                  </th>
                  <th className="py-1.5 pr-2 font-normal">
                    {t("integrations.audit.ip", "IP")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="py-1 pr-2 whitespace-nowrap">{fmtTs(r.ts)}</td>
                    <td className="py-1 pr-2 font-mono">{r.method}</td>
                    <td className="py-1 pr-2 font-mono break-all">{r.path}</td>
                    <td className="py-1 pr-2">
                      <span
                        className={
                          r.status >= 500
                            ? "text-destructive"
                            : r.status >= 400
                              ? "text-amber-600 dark:text-amber-400"
                              : ""
                        }
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="py-1 pr-2 font-mono text-muted-foreground">
                      {r.ip || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <DialogFooter>
          <Button onClick={onClose}>{t("actions.close", "Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

function CreateCredentialDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: IssuedCredential) => void;
}) {
  const { t } = useTranslation("settings");
  const { settings } = useSettingsContext();
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("webhook");
  const [scopeFamily, setScopeFamily] = useState<"files.write" | "files.read">("files.write");
  const [scopePath, setScopePath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // If the chosen protocol's surface is currently disabled in Settings →
  // General, the credential will mint successfully but the surface route
  // won't be mounted until the toggle is flipped + server restarted. Warn
  // inline so the owner is not surprised by a 404 from the freshly-issued URL.
  const surfaces = settings?.integrations?.surfaces;
  const protocolDisabled =
    !!surfaces &&
    ((protocol === "webhook" && !surfaces.webhook) ||
      (protocol === "webdav" && !surfaces.webdav) ||
      (protocol === "s3" && !surfaces.s3));

  // Reset form when reopening.
  useEffect(() => {
    if (open) {
      setName("");
      setProtocol("webhook");
      setScopeFamily("files.write");
      setScopePath("");
      setError(null);
    }
  }, [open]);

  const submit = useCallback(async () => {
    setError(null);
    if (!name.trim()) {
      setError(t("integrations.errors.nameRequired", "Name is required."));
      return;
    }
    if (!scopePath.trim()) {
      setError(t("integrations.errors.scopeRequired", "Folder path is required."));
      return;
    }
    const path = scopePath.startsWith("/") ? scopePath : `/${scopePath}`;
    setSubmitting(true);
    try {
      const res = await api.post("/api/connect/credentials", {
        name: name.trim(),
        protocol,
        scope: `${scopeFamily}:${path}`,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message || `HTTP ${res.status}`);
      }
      const json = await res.json();
      onCreated(json.data as IssuedCredential);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [name, protocol, scopeFamily, scopePath, onCreated, t]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("integrations.create.title", "New credential")}</DialogTitle>
          <DialogDescription>
            {t(
              "integrations.create.description",
              "Mint a credential bound to one folder. The raw secret is shown once \u2014 capture it now.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t("integrations.create.nameLabel", "Name")}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t(
                "integrations.create.namePlaceholder",
                "Apple Health Shortcut",
              )}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t("integrations.create.protocolLabel", "Protocol")}
            </label>
            {protocolDisabled && (
              <div className="text-xs rounded-md bg-muted/60 text-muted-foreground p-2">
                {t(
                  "integrations.create.surfaceDisabled",
                  "This protocol is currently disabled in Settings \u2192 General. The credential will mint, but requests to its URL will 404 until you enable the toggle.",
                )}
              </div>
            )}
            <Select value={protocol} onValueChange={(v) => setProtocol(v as Protocol)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="webhook">HTTP webhook</SelectItem>
                <SelectItem value="webdav">WebDAV</SelectItem>
                <SelectItem value="s3">S3-compatible</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t("integrations.create.scopeLabel", "Scope")}
            </label>
            <div className="flex gap-2">
              <Select
                value={scopeFamily}
                onValueChange={(v) => setScopeFamily(v as typeof scopeFamily)}
              >
                <SelectTrigger className="w-40 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="files.write">files.write</SelectItem>
                  <SelectItem value="files.read">files.read</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={scopePath}
                onChange={(e) => setScopePath(e.target.value)}
                placeholder="/health/apple/raw"
                className="font-mono"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                "integrations.create.scopeHint",
                "Folder under your data root. The credential will only see this subtree.",
              )}
            </p>
          </div>

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 rounded-md p-2">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("actions.cancel", "Cancel")}
          </Button>
          <Button onClick={submit} disabled={submitting} className="gap-2">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("integrations.create.submit", "Create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Secret-reveal dialog (one-shot)
// ---------------------------------------------------------------------------

function SecretRevealDialog({
  issued,
  onClose,
}: {
  issued: IssuedCredential | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback(async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied((curr) => (curr === label ? null : curr)), 1500);
    } catch {
      /* clipboard may be blocked; user can still select-copy */
    }
  }, []);

  if (!issued) return null;

  return (
    <Dialog open={!!issued} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("integrations.reveal.title", "Save your credentials")}</DialogTitle>
          <DialogDescription>
            {t(
              "integrations.reveal.description",
              "These values are shown once. Copy them into your app now \u2014 you cannot retrieve them later.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {issued.protocol === "webhook" && (
            <>
              <SecretField
                label={t("integrations.reveal.webhookUrl", "Webhook URL")}
                value={`${typeof window !== "undefined" ? window.location.origin : ""}/webhook/${issued.id}/{filename}`}
                copyKey="webhookUrl"
                copied={copied}
                onCopy={copy}
                mono
              />
              <p className="text-xs text-muted-foreground -mt-1">
                {t(
                  "integrations.reveal.webhookHint",
                  "Replace `{filename}` with the destination path under your scope folder.",
                )}
              </p>
            </>
          )}
          {issued.protocol === "webdav" && (
            <>
              <SecretField
                label={t("integrations.reveal.webdavMountUrl", "Mount URL")}
                value={`${typeof window !== "undefined" ? window.location.origin : ""}/webdav/`}
                copyKey="webdavMountUrl"
                copied={copied}
                onCopy={copy}
                mono
              />
              <p className="text-xs text-muted-foreground -mt-1">
                {t(
                  "integrations.reveal.webdavHint",
                  "Mount this URL with your username and password in any WebDAV client (Finder, Files, Cyberduck, Obsidian Remotely Save).",
                )}
              </p>
            </>
          )}
          {issued.protocol === "s3" && (
            <>
              <SecretField
                label={t("integrations.reveal.s3Endpoint", "Endpoint URL")}
                value={`${typeof window !== "undefined" ? window.location.origin : ""}/s3`}
                copyKey="s3Endpoint"
                copied={copied}
                onCopy={copy}
                mono
              />
              <SecretField
                label={t("integrations.reveal.s3Bucket", "Bucket name")}
                value={s3BucketNameForScope(issued.scope)}
                copyKey="s3Bucket"
                copied={copied}
                onCopy={copy}
                mono
              />
              <p className="text-xs text-muted-foreground -mt-1">
                {t(
                  "integrations.reveal.s3Hint",
                  "Configure your S3 client (rclone, restic, Duplicati) with this endpoint, bucket, access key id, and secret. Use path-style addressing and any region (the server ignores it).",
                )}
              </p>
            </>
          )}
          {issued.publicId && (
            <SecretField
              label={
                issued.protocol === "s3"
                  ? t("integrations.reveal.accessKeyId", "Access key id")
                  : t("integrations.reveal.username", "Username")
              }
              value={issued.publicId}
              copyKey="public"
              copied={copied}
              onCopy={copy}
            />
          )}
          <SecretField
            label={
              issued.protocol === "s3"
                ? t("integrations.reveal.secretAccessKey", "Secret access key")
                : issued.protocol === "webdav"
                  ? t("integrations.reveal.password", "Password")
                  : t("integrations.reveal.bearerToken", "Bearer token")
            }
            value={issued.secret}
            copyKey="secret"
            copied={copied}
            onCopy={copy}
            mono
          />
        </div>

        <DialogFooter>
          <Button onClick={onClose}>{t("actions.done", "Done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretField({
  label,
  value,
  copyKey,
  copied,
  onCopy,
  mono,
}: {
  label: string;
  value: string;
  copyKey: string;
  copied: string | null;
  onCopy: (key: string, value: string) => void;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <div className="flex gap-2">
        <Input
          value={value}
          readOnly
          className={mono ? "font-mono text-xs" : ""}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onCopy(copyKey, value)}
          className="shrink-0"
        >
          {copied === copyKey ? (
            <Check className="h-4 w-4 text-primary" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

// s3BucketNameForScope mirrors the backend helper of the same name in
// backend/api/s3.go. Turns a scope path like "files.write:/health/apple/raw"
// into the decorative bucket name "health-apple-raw" the server will
// expose via ListBuckets. Kept simple — split on the colon, strip
// slashes, replace inner slashes with dashes; "/" maps to "root".
function s3BucketNameForScope(scope: string): string {
  const colonIdx = scope.indexOf(":");
  const path = colonIdx >= 0 ? scope.slice(colonIdx + 1) : scope;
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "root";
  return trimmed.replace(/\//g, "-");
}
