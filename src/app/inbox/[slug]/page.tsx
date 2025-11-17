import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getFileByPath } from '@/lib/db/files';
import { readPrimaryText, readDigestSummary, readDigestTags, readDigestScreenshot, readDigestSlug } from '@/lib/inbox/digest-artifacts';
import { getDigestStatusView } from '@/lib/inbox/status-view';
import { CrawlButton } from '../_components/crawl-button';
import { SummaryButton } from '../_components/summary-button';
import { TaggingButton } from '../_components/tagging-button';
import { SlugButton } from '../_components/slug-button';
import { DigestCoordinator } from './_components/digest-coordinator';
import { IndexButton } from '../_components/index-button';

export const runtime = 'nodejs';

export default async function InboxDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: slugParam } = await params;
  const filePath = `inbox/${decodeURIComponent(slugParam)}`;

  // Look up file by path
  const file = getFileByPath(filePath);
  if (!file) return notFound();

  const [text, summary, tags, screenshot, digestSlug, statusView] = await Promise.all([
    readPrimaryText(filePath),
    readDigestSummary(filePath),
    readDigestTags(filePath),
    readDigestScreenshot(filePath),
    readDigestSlug(filePath),
    getDigestStatusView(filePath),
  ]);

  // Determine if this is a URL type (check if url.txt exists or text contains URL)
  const isUrlType = text && /^https?:\/\//i.test(text.trim().split('\n')[0]);

  return (
    <div className="min-h-screen bg-background">
      <div className="px-[20%] py-8 space-y-6">
        <div>
          <Link href="/inbox" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to Inbox
          </Link>
        </div>

        <div className="flex items-center flex-wrap gap-3">
          <span className="text-xs font-medium px-2 py-1 rounded-full bg-muted text-muted-foreground">
            {file.mimeType || 'unknown'}
          </span>
          {isUrlType && (
            <>
              <CrawlButton itemId={slugParam} />
              <SummaryButton itemId={slugParam} />
              <TaggingButton itemId={slugParam} />
            </>
          )}
          <IndexButton itemId={slugParam} />
          <SlugButton itemId={slugParam} />
        </div>

        <section className="bg-card rounded-lg border">
          <div className="border-b border-border px-6 py-4">
            <h2 className="text-sm font-semibold text-foreground">Original Text</h2>
            <p className="text-xs text-muted-foreground">Raw content from inbox files</p>
          </div>
          <div className="p-6">
            <div className="text-sm whitespace-pre-wrap break-words leading-7 text-foreground">
              {text && text.trim().length > 0 ? (
                text
              ) : (
                <span className="text-muted-foreground italic">No text content</span>
              )}
            </div>
          </div>
        </section>

        <DigestCoordinator
          itemId={slugParam}
          type={isUrlType ? 'url' : 'text'}
          initialSummary={summary}
          initialTags={tags}
          initialScreenshot={screenshot}
          initialSlug={digestSlug}
          initialStatus={statusView}
        />
      </div>
    </div>
  );
}
