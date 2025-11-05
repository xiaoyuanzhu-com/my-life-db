import { notFound } from 'next/navigation';
import fs from 'fs/promises';
import path from 'path';
import Link from 'next/link';
import { INBOX_DIR } from '@/lib/fs/storage';
import { getInboxItemByFolderName, getInboxItemById } from '@/lib/db/inbox';
import { CrawlButton } from '../_components/CrawlButton';

export const runtime = 'nodejs';

function isUUID(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value);
}

async function readFirstText(folderName: string): Promise<string | null> {
  const candidates = [
    'text.md',
    'note.md',
    'notes.md',
    'content.md',
    'digest/content.md',
    'digest/main-content.md',
    'url.txt',
  ];
  for (const name of candidates) {
    try {
      const p = path.join(INBOX_DIR, folderName, name);
      const buf = await fs.readFile(p);
      const s = buf.toString('utf-8').trim();
      if (s.length > 0) return s;
    } catch {}
  }
  return null;
}

export default async function InboxDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // Look up by folderName first (slug defaults to uuid initially)
  let item = getInboxItemByFolderName(slug);
  if (!item && isUUID(slug)) {
    item = getInboxItemById(slug);
  }
  if (!item) return notFound();

  const text = (await readFirstText(item.folderName)) || '';

  return (
    <div className="min-h-screen bg-background">
      <div className="px-[20%] py-8 space-y-6">
        <div>
          <Link href="/inbox" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to Inbox
          </Link>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs font-medium px-2 py-1 rounded-full bg-muted text-muted-foreground">
            {item.type}
          </span>
          {item.type === 'url' && (
            <CrawlButton inboxId={item.id} />
          )}
        </div>

        <div className="bg-card rounded-lg border">
          <div className="p-6">
            <div className="text-sm whitespace-pre-wrap break-words leading-7 text-foreground">
              {text ? text : <span className="text-muted-foreground italic">No text content</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
