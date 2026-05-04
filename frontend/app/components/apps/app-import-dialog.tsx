import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { marked, Renderer } from "marked";
import { ArrowRight, BadgeCheck, Check, ExternalLink, X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { useApp } from "~/hooks/use-apps";
import type {
  App,
  AppDetail,
  ImportOption,
  ImportSection,
} from "~/types/apps";

import { AppIconTile } from "./app-icon-tile";

interface Props {
  app: App | null;
  onOpenChange: (open: boolean) => void;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Custom marked renderer: turn `mld:` links into internal /agent?seed=...
// routes and force external links to open in a new tab.
function buildRenderer(): Renderer {
  const renderer = new Renderer();
  renderer.link = ({ href, title, text }) => {
    let finalHref = href;
    const mldMatch = href.match(/^mld:(?:\/\/)?(.*)$/);
    if (mldMatch) {
      finalHref = `/agent?seed=${encodeURIComponent(mldMatch[1])}`;
    } else if (!/^(https?:|mailto:|\/|#)/i.test(finalHref)) {
      finalHref = "#";
    }
    const safeHref = escapeHtml(finalHref);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const isInternal = finalHref.startsWith("/");
    const externalAttrs = isInternal
      ? ""
      : ' target="_blank" rel="noopener noreferrer"';
    return `<a href="${safeHref}"${titleAttr}${externalAttrs} class="underline text-primary hover:text-primary/80">${text}</a>`;
  };
  return renderer;
}

function renderMarkdown(md: string | undefined): string {
  if (!md) return "";
  return marked.parse(md, {
    renderer: buildRenderer(),
    gfm: true,
    breaks: true,
    async: false,
  }) as string;
}

export function AppImportDialog({ app, onOpenChange }: Props) {
  const navigate = useNavigate();
  const { t } = useTranslation("data");
  const { data: detail, isLoading, error } = useApp(app?.id ?? null);
  const localizedName = app ? t(`apps.names.${app.id}`, app.name) : "";

  const startSession = useCallback(
    (seed: string) => {
      onOpenChange(false);
      navigate(`/agent?seed=${encodeURIComponent(seed)}`);
    },
    [navigate, onOpenChange],
  );

  const handleBodyClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Let modifier-clicks fall through to the browser.
      if (
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      )
        return;
      const target = e.target as HTMLElement;
      const a = target.closest("a");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("/")) {
        e.preventDefault();
        onOpenChange(false);
        navigate(href);
      }
    },
    [navigate, onOpenChange],
  );

  const useStructured = !!detail?.import;
  const legacyHtml = useMemo(
    () => (useStructured ? "" : renderMarkdown(detail?.doc)),
    [useStructured, detail?.doc],
  );

  return (
    <Dialog open={!!app} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0 max-h-[85vh] flex flex-col">
        {app && (
          <>
            {/* Header: icon + name + category. Legacy header CTA only when
                using the markdown path; structured path puts CTAs per-option. */}
            <div className="flex items-center gap-4 px-6 pt-6 pb-4 shrink-0">
              <AppIconTile app={app} name={localizedName} />
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-xl font-semibold truncate">
                  {localizedName}
                </DialogTitle>
                <div className="text-xs text-muted-foreground capitalize mt-0.5">
                  {app.category}
                </div>
              </div>
              {!useStructured && detail?.importPrompt && (
                <Button
                  onClick={() => startSession(detail.importPrompt!)}
                  className="shrink-0"
                  size="sm"
                >
                  {t("apps.import.startImport", "Start import")}
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              )}
            </div>

            <div
              className="flex-1 overflow-y-auto px-6 pb-6"
              onClick={handleBodyClick}
            >
              {app.description && (
                <p className="text-sm text-muted-foreground mb-4">
                  {app.description}
                </p>
              )}

              {isLoading && (
                <div className="text-sm text-muted-foreground">Loading…</div>
              )}
              {error && (
                <div className="text-sm text-destructive">
                  Failed to load {app.id}
                </div>
              )}

              {detail && useStructured && (
                <StructuredImport detail={detail} onStart={startSession} />
              )}

              {detail && !useStructured && legacyHtml && (
                <div
                  className="prose dark:prose-invert max-w-none text-sm"
                  dangerouslySetInnerHTML={{ __html: legacyHtml }}
                />
              )}

              {detail && !useStructured && !legacyHtml && !isLoading && !error && (
                <div className="text-sm text-muted-foreground">
                  No instructions yet. Open a chat and describe what you want
                  to import — the agent can help.
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StructuredImport({
  detail,
  onStart,
}: {
  detail: AppDetail;
  onStart: (seed: string) => void;
}) {
  const { t } = useTranslation("data");
  const spec = detail.import!;
  return (
    <div className="flex flex-col gap-6">
      {spec.oneOff && (
        <ImportSectionView
          title={t("apps.import.oneOff", "One-off export")}
          section={spec.oneOff}
          onStart={onStart}
        />
      )}
      {spec.continuousSync && (
        <ImportSectionView
          title={t("apps.import.continuousSync", "Continuous sync")}
          section={spec.continuousSync}
          onStart={onStart}
        />
      )}
    </div>
  );
}

function ImportSectionView({
  title,
  section,
  onStart,
}: {
  title: string;
  section: ImportSection;
  onStart: (seed: string) => void;
}) {
  const { t } = useTranslation("data");
  return (
    <section className="flex flex-col gap-3">
      {/* Banner bar: section title (left) + feasibility verdict (right).
          Soft blue tint — the project's design tokens are monochromatic, so
          a subtle hue is needed here to distinguish the section break from
          the grey card headers below. */}
      <div className="flex items-center justify-between rounded-md bg-blue-50 dark:bg-blue-950/40 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-200">
          {title}
        </h3>
        {section.feasible ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <Check className="h-3.5 w-3.5" />
            {t("apps.import.supported", "Supported")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700/70 dark:text-blue-300/70">
            <X className="h-3.5 w-3.5" />
            {t("apps.import.notSupported", "Not supported")}
          </span>
        )}
      </div>

      {!section.feasible && section.reason && (
        <p className="px-1 text-sm text-muted-foreground">{section.reason}</p>
      )}

      {section.feasible && section.options && section.options.length > 0 && (
        <div className="flex flex-col gap-3">
          {section.options.map((opt) => (
            <ImportOptionCard key={opt.id} option={opt} onStart={onStart} />
          ))}
        </div>
      )}
    </section>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function ImportOptionCard({
  option,
  onStart,
}: {
  option: ImportOption;
  onStart: (seed: string) => void;
}) {
  const { t } = useTranslation("data");
  const descHtml = useMemo(
    () => renderMarkdown(option.description),
    [option.description],
  );
  return (
    <div className="rounded-lg bg-muted/50 overflow-hidden flex flex-col min-w-0">
      {/* Header bar: title (left) + Start import button (right). Official
          options get a small badge icon to flag the first-party path. */}
      <div className="flex items-center justify-between gap-3 bg-muted px-4 py-2.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="font-medium text-sm truncate">{option.name}</div>
          {option.official && (
            <BadgeCheck
              className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
              aria-label={t("apps.import.official", "Official")}
            />
          )}
        </div>
        <Button
          onClick={() => onStart(option.seedPrompt)}
          size="sm"
          className="shrink-0"
        >
          {t("apps.import.startImport", "Start import")}
          <ArrowRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
      {/* Body: description + optional source link */}
      <div className="px-4 py-3 flex flex-col gap-2">
        {descHtml && (
          <div
            className="prose dark:prose-invert max-w-none text-xs text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: descHtml }}
          />
        )}
        {option.url && (
          <a
            href={option.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground self-start"
          >
            {hostnameOf(option.url)}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        )}
      </div>
    </div>
  );
}
