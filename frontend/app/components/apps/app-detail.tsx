import { useMemo } from "react";
import { marked, Renderer } from "marked";
import { useNavigate } from "react-router";
import { useApp } from "~/hooks/use-apps";
import { Button } from "~/components/ui/button";
import { ArrowLeft, ExternalLink } from "lucide-react";

interface Props {
  id: string;
  onBack: () => void;
}

export function AppDetail({ id, onBack }: Props) {
  const { data: app, isLoading, error } = useApp(id);
  const navigate = useNavigate();

  const html = useMemo(() => {
    if (!app?.doc) return "";
    const renderer = new Renderer();
    renderer.link = ({ href, title, text }) => {
      let finalHref = href;
      if (href.startsWith("mld:")) {
        const prompt = href.slice(4);
        finalHref = `/agent?seed=${encodeURIComponent(prompt)}`;
      }
      const titleAttr = title ? ` title="${title}"` : "";
      const isInternal = finalHref.startsWith("/");
      const externalAttrs = isInternal ? "" : ' target="_blank" rel="noopener noreferrer"';
      return `<a href="${finalHref}"${titleAttr}${externalAttrs} class="underline text-primary hover:text-primary/80">${text}</a>`;
    };
    return marked.parse(app.doc, { renderer, gfm: true, breaks: true, async: false }) as string;
  }, [app?.doc]);

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (error || !app) return <div className="p-4 text-sm text-destructive">Failed to load {id}</div>;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        {app.website && (
          <a
            href={app.website}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground"
          >
            {app.website} <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <h1 className="text-2xl font-semibold mb-1">{app.name}</h1>
        <div className="text-xs text-muted-foreground capitalize mb-4">{app.category}</div>
        {app.description && (
          <p className="text-sm text-muted-foreground mb-6">{app.description}</p>
        )}
        {app.doc ? (
          <div
            className="prose dark:prose-invert max-w-none"
            onClick={(e) => {
              const t = e.target as HTMLElement;
              const a = t.closest("a");
              if (!a) return;
              const href = a.getAttribute("href") ?? "";
              if (href.startsWith("/")) {
                e.preventDefault();
                navigate(href);
              }
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="text-sm text-muted-foreground">
            No doc yet. Open a chat and describe what you want to import — the agent can help.
          </div>
        )}
      </div>
    </div>
  );
}
