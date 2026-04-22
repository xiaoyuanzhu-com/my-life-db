import { useMemo } from "react";
import { useNavigate } from "react-router";
import { marked, Renderer } from "marked";
import { ArrowRight, ExternalLink } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { useApp } from "~/hooks/use-apps";
import type { App } from "~/types/apps";

import { AppIconTile } from "./app-icon-tile";

interface Props {
  app: App | null;
  onOpenChange: (open: boolean) => void;
}

// Escape for safe interpolation into HTML attribute or text content.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function AppImportDialog({ app, onOpenChange }: Props) {
  const navigate = useNavigate();
  const { data: detail, isLoading, error } = useApp(app?.id ?? null);

  const html = useMemo(() => {
    if (!detail?.doc) return "";
    const renderer = new Renderer();
    renderer.link = ({ href, title, text }) => {
      let finalHref = href;
      // `mld:` and `mld://` both strip to the prompt body.
      const mldMatch = href.match(/^mld:(?:\/\/)?(.*)$/);
      if (mldMatch) {
        finalHref = `/agent?seed=${encodeURIComponent(mldMatch[1])}`;
      } else if (!/^(https?:|mailto:|\/|#)/i.test(finalHref)) {
        // Defense-in-depth: drop `javascript:` / `data:` URLs.
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
    return marked.parse(detail.doc, {
      renderer,
      gfm: true,
      breaks: true,
      async: false,
    }) as string;
  }, [detail?.doc]);

  const handleStartImport = () => {
    if (!detail?.importPrompt) return;
    onOpenChange(false);
    navigate(`/agent?seed=${encodeURIComponent(detail.importPrompt)}`);
  };

  return (
    <Dialog open={!!app} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0 max-h-[85vh] flex flex-col">
        {app && (
          <>
            {/* Header: icon + name + category + optional CTA */}
            <div className="flex items-center gap-4 px-6 pt-6 pb-4 shrink-0">
              <AppIconTile app={app} />
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-xl font-semibold truncate">
                  {app.name}
                </DialogTitle>
                <div className="text-xs text-muted-foreground capitalize mt-0.5">
                  {app.category}
                </div>
              </div>
              {detail?.importPrompt && (
                <Button
                  onClick={handleStartImport}
                  className="shrink-0"
                  size="sm"
                >
                  Start import
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              )}
            </div>

            {/* Body: description + doc */}
            <div
              className="flex-1 overflow-y-auto px-6 pb-6"
              onClick={(e) => {
                // Let the browser handle modifier-clicks.
                if (
                  e.button !== 0 ||
                  e.metaKey ||
                  e.ctrlKey ||
                  e.shiftKey ||
                  e.altKey
                )
                  return;
                const t = e.target as HTMLElement;
                const a = t.closest("a");
                if (!a) return;
                const href = a.getAttribute("href") ?? "";
                if (href.startsWith("/")) {
                  e.preventDefault();
                  onOpenChange(false);
                  navigate(href);
                }
              }}
            >
              {app.description && (
                <p className="text-sm text-muted-foreground mb-4">
                  {app.description}
                </p>
              )}
              {app.website && (
                <a
                  href={app.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-4"
                >
                  {app.website}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {isLoading && (
                <div className="text-sm text-muted-foreground">Loading…</div>
              )}
              {error && (
                <div className="text-sm text-destructive">
                  Failed to load {app.id}
                </div>
              )}
              {detail?.doc ? (
                <div
                  className="prose dark:prose-invert max-w-none text-sm"
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              ) : (
                !isLoading &&
                !error && (
                  <div className="text-sm text-muted-foreground">
                    No instructions yet. Open a chat and describe what you want
                    to import — the agent can help.
                  </div>
                )
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
