/**
 * DELETE /api/digest/reset/[digester]
 * Deletes all digests for a specific digester type
 */

import { NextRequest, NextResponse } from 'next/server';
import { withDatabase } from '@/lib/db/client';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'api/digest/reset' });

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ digester: string }> }
) {
  try {
    const { digester } = await params;

    if (!digester) {
      return NextResponse.json(
        { error: 'Digester type is required' },
        { status: 400 }
      );
    }

    return withDatabase((db) => {
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
  } catch (error) {
    log.error({ error }, 'failed to delete digests');
    return NextResponse.json(
      { error: 'Failed to delete digests' },
      { status: 500 }
    );
  }
}
