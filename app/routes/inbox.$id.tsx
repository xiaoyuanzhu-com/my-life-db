import { useState, useEffect } from "react";
import { useParams, Link } from "react-router";
import { CrawlButton } from "~/components/inbox/crawl-button";
import { SummaryButton } from "~/components/inbox/summary-button";
import { TaggingButton } from "~/components/inbox/tagging-button";
import { DigestCoordinator } from "~/components/inbox/digest-coordinator";
import { IndexButton } from "~/components/inbox/index-button";
import type { InboxDigestScreenshot, DigestStatusSummary as DigestStatusView } from "~/types";

interface InboxDetail {
  path: string;
  name: string;
  mimeType: string | null;
  primaryText: string | null;
  digest: {
    summary: string | null;
    tags: string[] | null;
    screenshot: InboxDigestScreenshot | null;
  };
  enrichment: DigestStatusView | null;
}

export default function InboxDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState<InboxDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      if (!id) return;
      setIsLoading(true);
      try {
        const response = await fetch(`/api/inbox/${encodeURIComponent(id)}`);
        if (!response.ok) {
          if (response.status === 404) {
            setError("Item not found");
          } else {
            setError("Failed to load item");
          }
          return;
        }
        const result = await response.json();
        setData(result);
      } catch (err) {
        console.error("Failed to load inbox item:", err);
        setError("Failed to load item");
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
  }, [id]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background">
        <div className="px-[20%] py-8">
          <Link to="/inbox" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to Inbox
          </Link>
          <div className="mt-8 text-center text-muted-foreground">{error || "Item not found"}</div>
        </div>
      </div>
    );
  }

  const isUrlType = data.primaryText && /^https?:\/\//i.test(data.primaryText.trim().split("\n")[0]);

  return (
    <div className="min-h-screen bg-background">
      <div className="px-[20%] py-8 space-y-6">
        <div>
          <Link to="/inbox" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to Inbox
          </Link>
        </div>

        <div className="flex items-center flex-wrap gap-3">
          <span className="text-xs font-medium px-2 py-1 rounded-full bg-muted text-muted-foreground">
            {data.mimeType || "unknown"}
          </span>
          {isUrlType && (
            <>
              <CrawlButton itemId={id!} />
              <SummaryButton itemId={id!} />
              <TaggingButton itemId={id!} />
            </>
          )}
          <IndexButton itemId={id!} />
        </div>

        <section className="bg-card rounded-lg border">
          <div className="border-b border-border px-6 py-4">
            <h2 className="text-sm font-semibold text-foreground">Original Text</h2>
            <p className="text-xs text-muted-foreground">Raw content from inbox files</p>
          </div>
          <div className="p-6">
            <div className="text-sm whitespace-pre-wrap break-words leading-7 text-foreground">
              {data.primaryText && data.primaryText.trim().length > 0 ? (
                data.primaryText
              ) : (
                <span className="text-muted-foreground italic">No text content</span>
              )}
            </div>
          </div>
        </section>

        <DigestCoordinator
          itemId={id!}
          initialSummary={data.digest.summary}
          initialTags={data.digest.tags}
          initialScreenshot={data.digest.screenshot}
          initialStatus={data.enrichment}
        />
      </div>
    </div>
  );
}
