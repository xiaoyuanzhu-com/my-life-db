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

async function readFileIfExists(folderName: string, relativePath: string): Promise<Buffer | null> {
  try {
    const filePath = path.join(INBOX_DIR, folderName, relativePath);
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

async function readFirstText(folderName: string): Promise<string | null> {
  const candidates = [
    'text.md',
    'note.md',
    'notes.md',
    'content.md',
    'main-content.md',
    'url.txt',
  ];
  for (const name of candidates) {
    const file = await readFileIfExists(folderName, name);
    if (!file) continue;
    const content = file.toString('utf-8').trim();
    if (content.length > 0) return content;
  }
  return null;
}

async function readDigestMarkdown(folderName: string): Promise<string | null> {
  const candidates = ['digest/content.md', 'digest/main-content.md', 'digest/summary.md'];
  for (const name of candidates) {
    const file = await readFileIfExists(folderName, name);
    if (!file) continue;
    const content = file.toString('utf-8').trim();
    if (content.length > 0) return content;
  }
  return null;
}

async function readDigestHtml(folderName: string): Promise<string | null> {
  const file = await readFileIfExists(folderName, 'digest/content.html');
  if (!file) return null;
  const content = file.toString('utf-8').trim();
  return content.length > 0 ? content : null;
}

async function readScreenshot(folderName: string): Promise<{ src: string; mimeType: string; filename: string } | null> {
  const candidates: Array<{ name: string; mimeType: string }> = [
    { name: 'digest/screenshot.png', mimeType: 'image/png' },
    { name: 'digest/screenshot.jpg', mimeType: 'image/jpeg' },
    { name: 'digest/screenshot.jpeg', mimeType: 'image/jpeg' },
    { name: 'digest/screenshot.webp', mimeType: 'image/webp' },
  ];

  for (const candidate of candidates) {
    const file = await readFileIfExists(folderName, candidate.name);
    if (!file) continue;
    const base64 = file.toString('base64');
    return {
      filename: candidate.name,
      mimeType: candidate.mimeType,
      src: `data:${candidate.mimeType};base64,${base64}`,
    };
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

  const [text, digestMarkdown, digestHtml, screenshot] = await Promise.all([
    readFirstText(item.folderName),
    readDigestMarkdown(item.folderName),
    readDigestHtml(item.folderName),
    readScreenshot(item.folderName),
  ]);

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

        {(digestMarkdown || digestHtml) && (
          <section className="bg-card rounded-lg border">
            <div className="border-b border-border px-6 py-4">
              <h2 className="text-sm font-semibold text-foreground">Digest</h2>
              <p className="text-xs text-muted-foreground">Markdown extracted from enrichment</p>
            </div>
            <div className="p-6">
              {digestHtml ? (
                <div
                  className="text-sm leading-7 text-foreground"
                  dangerouslySetInnerHTML={{ __html: digestHtml }}
                />
              ) : (
                <div className="text-sm whitespace-pre-wrap break-words leading-7 text-foreground">
                  {digestMarkdown}
                </div>
              )}
            </div>
          </section>
        )}

        {screenshot && (
          <section className="bg-card rounded-lg border">
            <div className="border-b border-border px-6 py-4">
              <h2 className="text-sm font-semibold text-foreground">Screenshot</h2>
              <p className="text-xs text-muted-foreground">{screenshot.filename}</p>
            </div>
            <div className="p-6">
              <img
                src={screenshot.src}
                alt="Captured page screenshot"
                loading="lazy"
                className="w-full h-auto rounded-md border border-border bg-muted"
              />
            </div>
          </section>
        )}

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
      </div>
    </div>
  );
}
