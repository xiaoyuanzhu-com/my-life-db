import { NextRequest, NextResponse } from 'next/server';
import { listEntries, updateEntry } from '@/lib/fs/storage';
import { batchProcessEntries } from '@/lib/ai/processor';
import type { ExtractionOptions } from '@/types';

/**
 * POST /api/entries/process
 * Batch process multiple entries with AI extraction
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    const options: ExtractionOptions = {
      includeEntities: body.includeEntities !== false,
      includeSentiment: body.includeSentiment !== false,
      includeActionItems: body.includeActionItems !== false,
      includeRelatedEntries: body.includeRelatedEntries === true,
      minConfidence: body.minConfidence || 0.5,
    };

    // Get entries to process
    const basePath = body.basePath || 'inbox';
    const limit = body.limit || 50;
    const onlyUnprocessed = body.onlyUnprocessed !== false;

    let entries = await listEntries(basePath);

    // Filter to only unprocessed entries if requested
    if (onlyUnprocessed) {
      entries = entries.filter((entry) => !entry.metadata.ai.processed);
    }

    // Limit number of entries
    entries = entries.slice(0, limit);

    if (entries.length === 0) {
      return NextResponse.json({
        success: true,
        processed: 0,
        message: 'No entries to process',
      });
    }

    // Process entries in batch
    const results = await batchProcessEntries(entries, options);

    // Save updated metadata for each entry
    const saved = await Promise.all(
      Array.from(results.entries()).map(async ([id, metadata]) => {
        const entry = entries.find((e) => e.metadata.id === id);
        if (entry) {
          await updateEntry(entry.directoryPath, { metadata });
          return id;
        }
        return null;
      })
    );

    const successCount = saved.filter((id) => id !== null).length;

    return NextResponse.json({
      success: true,
      processed: successCount,
      total: entries.length,
      entries: Array.from(results.keys()),
    });
  } catch (error) {
    console.error('Error batch processing entries:', error);
    return NextResponse.json(
      {
        error: 'Failed to batch process entries',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
