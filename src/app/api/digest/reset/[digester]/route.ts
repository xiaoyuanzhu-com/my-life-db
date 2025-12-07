/**
 * DELETE /api/digest/reset/[digester]
 * Deletes all digests for a specific digester type
 */

import { NextRequest, NextResponse } from 'next/server';
import { withDatabase } from '@/lib/db/client';
import { getLogger } from '@/lib/log/logger';
import { ensureAllDigestersForExistingFiles } from '@/lib/digest/ensure';
import { deleteAllEmbeddings } from '@/lib/db/people';

const log = getLogger({ module: 'api/digest/reset' });

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ digester: string }> }
) {
  const { digester } = await params;

  try {
    if (!digester) {
      return NextResponse.json(
        { error: 'Digester type is required' },
        { status: 400 }
      );
    }

    // For speaker-embedding, delete embeddings FIRST (synchronously)
    // This must happen before any digest processing can occur
    let embeddingsDeleted = 0;
    if (digester === 'speaker-embedding') {
      try {
        embeddingsDeleted = deleteAllEmbeddings();
        log.info({ embeddingsDeleted }, 'cleared people embeddings');
      } catch (error) {
        log.warn({ error }, 'failed to clear people embeddings');
      }
    }

    const deletedCount = withDatabase((db) => {
      // Get count before deletion
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM digests WHERE digester = ?');
      const { count } = countStmt.get(digester) as { count: number };

      if (count === 0) {
        return 0;
      }

      // Delete all digests for this digester type
      const deleteStmt = db.prepare('DELETE FROM digests WHERE digester = ?');
      const result = deleteStmt.run(digester);

      log.info(
        { digester, deletedCount: result.changes },
        'deleted digests for digester'
      );

      return result.changes;
    });

    // Clear search indexes if resetting search digesters
    if (digester === 'search-keyword') {
      try {
        const { getMeiliClient } = await import('@/lib/search/meili-client');
        const meiliClient = await getMeiliClient();
        const taskUid = await meiliClient.deleteAllDocuments();
        log.info({ taskUid }, 'cleared Meilisearch index');
      } catch (error) {
        log.warn({ error }, 'failed to clear Meilisearch index');
      }
    } else if (digester === 'search-semantic') {
      try {
        const { getQdrantClient } = await import('@/lib/search/qdrant-client');
        const qdrantClient = await getQdrantClient();
        await qdrantClient.deleteAll();
        log.info({}, 'cleared Qdrant collection');
      } catch (error) {
        log.warn({ error }, 'failed to clear Qdrant collection');
      }
    }

    // Recreate digest placeholders for all files
    ensureAllDigestersForExistingFiles();

    return NextResponse.json({
      message: deletedCount > 0
        ? `Successfully deleted ${deletedCount} digest(s)`
        : 'No digests found for this digester',
      count: deletedCount,
      digester,
      embeddingsDeleted,
    });
  } catch (error) {
    log.error({ error }, 'failed to delete digests');
    return NextResponse.json(
      { error: 'Failed to delete digests' },
      { status: 500 }
    );
  }
}
