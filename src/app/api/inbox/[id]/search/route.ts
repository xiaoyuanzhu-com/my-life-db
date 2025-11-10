import { NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { getInboxItemById } from '@/lib/db/inbox';
import { getStorageConfig } from '@/lib/config/storage';
import { ingestMarkdownForSearch } from '@/lib/search/ingest-url-content';
import {
  enqueueSearchDelete,
  enqueueSearchIndex,
  enqueueVectorDelete,
  enqueueVectorIndex,
} from '@/lib/search/tasks';
import type { InboxFile, InboxItem } from '@/types';
import type { SearchDocumentMetadata } from '@/lib/search/types';
import { getLogger } from '@/lib/log/logger';

export const runtime = 'nodejs';

const log = getLogger({ module: 'ApiInboxSearchIndex' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const item = getInboxItemById(id);
    if (!item) {
      return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 });
    }

    const storage = await getStorageConfig();
    const dataRoot = storage.dataPath || './data';
    const inboxDir = path.join(dataRoot, '.app', 'mylifedb', 'inbox', item.folderName);
    const digestDir = path.join(inboxDir, 'digest');
    const markdownPath = path.join(digestDir, 'content.md');

    try {
      await fs.access(markdownPath);
    } catch {
      return NextResponse.json(
        { error: 'digest/content.md not found for this inbox item' },
        { status: 400 }
      );
    }

    const metadata = await buildSearchMetadata(item, digestDir, inboxDir, dataRoot);
    const ingestResult = await ingestMarkdownForSearch({
      entryId: item.id,
      libraryId: null,
      markdownPath,
      sourcePath: path.relative(dataRoot, markdownPath),
      sourceUrl: metadata.url,
      metadata,
    });

    if (ingestResult.chunkCount === 0) {
      return NextResponse.json(
        { error: 'No searchable chunks produced from digest/content.md' },
        { status: 400 }
      );
    }

    const tasks: Array<{ type: string; taskId: string | null; count: number }> = [];

    if (ingestResult.documentIds.length > 0) {
      const searchTask = enqueueSearchIndex(ingestResult.documentIds);
      const vectorTask = enqueueVectorIndex(ingestResult.documentIds);
      tasks.push({ type: 'search_index', taskId: searchTask, count: ingestResult.documentIds.length });
      tasks.push({ type: 'search_vector_index', taskId: vectorTask, count: ingestResult.documentIds.length });
    }

    if (ingestResult.staleDocumentIds.length > 0) {
      const deleteTask = enqueueSearchDelete(ingestResult.staleDocumentIds);
      const vectorDeleteTask = enqueueVectorDelete(ingestResult.staleDocumentIds);
      tasks.push({ type: 'search_delete', taskId: deleteTask, count: ingestResult.staleDocumentIds.length });
      tasks.push({ type: 'search_vector_delete', taskId: vectorDeleteTask, count: ingestResult.staleDocumentIds.length });
    }

    return NextResponse.json({
      success: true,
      chunks: ingestResult.chunkCount,
      documentIds: ingestResult.documentIds,
      staleDocumentIds: ingestResult.staleDocumentIds,
      tasks,
    });
  } catch (error) {
    log.error({ err: error }, 'manual search indexing failed');
    return NextResponse.json({ error: 'Failed to queue search indexing' }, { status: 500 });
  }
}

async function buildSearchMetadata(
  item: InboxItem,
  digestDir: string,
  inboxDir: string,
  dataRoot: string
): Promise<SearchDocumentMetadata> {
  const { readInboxDigestTags, readInboxDigestSlug } = await import('@/lib/inbox/digestArtifacts');

  const infoSource = item.files.find((file) => Boolean(file.enrichment?.url));
  const screenshotFile = findFirstFile(item.files, (file) =>
    file.filename.startsWith('digest/screenshot')
  );

  const digestPath = path.relative(dataRoot, digestDir);
  const screenshotPath = screenshotFile
    ? path.relative(dataRoot, path.join(inboxDir, screenshotFile.filename))
    : null;

  const enrichment = infoSource?.enrichment ?? {};
  let hostname: string | null = null;
  let pathName: string | null = null;
  const url = enrichment.url ?? null;

  if (url) {
    try {
      const parsed = new URL(url);
      hostname = parsed.hostname;
      pathName = parsed.pathname;
    } catch {
      // ignore parse errors
    }
  }

  // Load AI-generated tags from digest/tags.json
  const aiTags = await readInboxDigestTags(item.folderName);

  // Load AI-generated slug/title from digest/slug.json
  const slugData = await readInboxDigestSlug(item.folderName);
  const title = slugData?.title || enrichment.title || null;

  return {
    title,
    description: null, // TODO: Load from AI-generated summary if needed
    author: enrichment.author ?? null,
    tags: aiTags || [],
    digestPath,
    screenshotPath,
    url,
    hostname,
    path: pathName,
    capturedAt: item.enrichedAt ?? new Date().toISOString(),
  };
}

function findFirstFile(files: InboxFile[], predicate: (file: InboxFile) => boolean): InboxFile | undefined {
  return files.find(predicate);
}
