/**
 * DELETE /api/digest/reset/[digester]
 * Deletes all digests for a specific digester type
 */

import { NextRequest, NextResponse } from 'next/server';
import { withDatabase } from '@/lib/db/client';
import { getLogger } from '@/lib/log/logger';
import { ensureAllDigestersForExistingFiles } from '@/lib/digest/ensure';

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

    const response = withDatabase((db) => {
      // Get count before deletion
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM digests WHERE digester = ?');
      const { count } = countStmt.get(digester) as { count: number };

      if (count === 0) {
        return NextResponse.json(
          { message: 'No digests found for this digester', count: 0 },
          { status: 200 }
        );
      }

      // Delete all digests for this digester type
      const deleteStmt = db.prepare('DELETE FROM digests WHERE digester = ?');
      const result = deleteStmt.run(digester);

      log.info(
        { digester, deletedCount: result.changes },
        'deleted digests for digester'
      );

      return NextResponse.json({
        message: `Successfully deleted ${result.changes} digest(s)`,
        count: result.changes,
        digester,
      });
    });

    // After successful deletion, recreate digest placeholders and clear search indexes
    // This runs asynchronously without blocking the response
    setImmediate(async () => {
      try {
        // Recreate digest placeholders for all files
        // This will create new 'todo' records for the deleted digester
        ensureAllDigestersForExistingFiles();

        // Clear search indexes if resetting search digesters
        if (digester === 'search-keyword') {
          // Clear Meilisearch index
          try {
            const { getMeiliClient } = await import('@/lib/search/meili-client');
            const meiliClient = await getMeiliClient();
            const taskUid = await meiliClient.deleteAllDocuments();
            log.info({ taskUid }, 'cleared Meilisearch index');
          } catch (error) {
            log.warn({ error }, 'failed to clear Meilisearch index');
          }
        } else if (digester === 'search-semantic') {
          // Clear Qdrant collection
          try {
            const { getQdrantClient } = await import('@/lib/search/qdrant-client');
            const qdrantClient = await getQdrantClient();
            await qdrantClient.deleteAll();
            log.info({}, 'cleared Qdrant collection');
          } catch (error) {
            log.warn({ error }, 'failed to clear Qdrant collection');
          }
        }
      } catch (error) {
        log.error({ error }, 'failed to recreate digest placeholders or clear search indexes');
      }
    });

    return response;
  } catch (error) {
    log.error({ error }, 'failed to delete digests');
    return NextResponse.json(
      { error: 'Failed to delete digests' },
      { status: 500 }
    );
  }
}
