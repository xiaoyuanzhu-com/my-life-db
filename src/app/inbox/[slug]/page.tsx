import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getInboxItemByFolderName, getInboxItemById } from '@/lib/db/inbox';
import { readInboxPrimaryText, readInboxDigestSummary, readInboxDigestTags, readInboxDigestScreenshot } from '@/lib/inbox/digestArtifacts';
import { getInboxStatusView } from '@/lib/inbox/statusView';
import { CrawlButton } from '../_components/CrawlButton';
import { SummaryButton } from '../_components/SummaryButton';
import { TaggingButton } from '../_components/TaggingButton';
import { DigestCoordinator } from './_components/DigestCoordinator';

export const runtime = 'nodejs';

function isUUID(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value);
}

export default async function InboxDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // Look up by folderName first (slug defaults to uuid initially)
  let item = getInboxItemByFolderName(slug);
  if (!item && isUUID(slug)) {
    item = getInboxItemById(slug);
  }
  if (!item) return notFound();

  const [text, summary, tags, screenshot, statusView] = await Promise.all([
    readInboxPrimaryText(item.folderName),
    readInboxDigestSummary(item.folderName),
    readInboxDigestTags(item.folderName),
    readInboxDigestScreenshot(item.folderName),
    getInboxStatusView(item.id),
  ]);

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
            {item.type}
          </span>
          {item.type === 'url' && (
            <>
              <CrawlButton inboxId={item.id} />
              <SummaryButton inboxId={item.id} />
              <TaggingButton inboxId={item.id} />
            </>
          )}
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
          inboxId={item.id}
          type={item.type}
          initialSummary={summary}
          initialTags={tags}
          initialScreenshot={screenshot}
          initialStatus={statusView}
        />
      </div>
    </div>
  );
}
