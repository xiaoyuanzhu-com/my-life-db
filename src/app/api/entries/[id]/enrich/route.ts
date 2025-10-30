import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { findEntryByUUID, updateEntry } from '@/lib/fs/storage';
import { enrichEntry } from '@/lib/ai/enricher';
import type { ExtractionOptions } from '@/types';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiEntryEnrich' });

/**
 * POST /api/entries/[id]/enrich
 * Enrich an entry with AI extraction (title, tags, summary, entities, etc.)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Find the entry
    const entry = await findEntryByUUID(id);
    if (!entry) {
      return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    }

    // Get extraction options from request body
    const body = await request.json().catch(() => ({}));
    const options: ExtractionOptions = {
      includeEntities: body.includeEntities !== false,
      includeSentiment: body.includeSentiment !== false,
      includeActionItems: body.includeActionItems !== false,
      includeRelatedEntries: body.includeRelatedEntries === true,
      minConfidence: body.minConfidence || 0.5,
    };

    // Enrich the entry with AI
    const updatedMetadata = await enrichEntry(entry, options);

    // Save the updated metadata
    const updatedEntry = await updateEntry(entry.directoryPath, {
      metadata: updatedMetadata,
    });

    if (!updatedEntry) {
      return NextResponse.json({ error: 'Failed to update entry' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      entry: updatedEntry,
      extraction: {
        enriched: updatedMetadata.ai.enriched,
        enrichedAt: updatedMetadata.ai.enrichedAt,
        title: updatedMetadata.ai.title,
        summary: updatedMetadata.ai.summary,
        tags: updatedMetadata.ai.tags,
        category: updatedMetadata.ai.category,
        sentiment: updatedMetadata.ai.sentiment,
        priority: updatedMetadata.ai.priority,
        entities: updatedMetadata.ai.entities,
        actionItems: updatedMetadata.ai.actionItems,
        confidence: updatedMetadata.ai.confidence,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'enrich entry failed');
    return NextResponse.json(
      { error: 'Failed to enrich entry', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/entries/[id]/enrich
 * Get the enrichment status for an entry
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Find the entry
    const entry = await findEntryByUUID(id);
    if (!entry) {
      return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: entry.metadata.id,
      enriched: entry.metadata.ai.enriched,
      enrichedAt: entry.metadata.ai.enrichedAt,
      hasExtraction: {
        title: Boolean(entry.metadata.ai.title),
        summary: Boolean(entry.metadata.ai.summary),
        tags: entry.metadata.ai.tags && entry.metadata.ai.tags.length > 0,
        entities: Boolean(entry.metadata.ai.entities),
        category: Boolean(entry.metadata.ai.category),
        sentiment: Boolean(entry.metadata.ai.sentiment),
      },
      confidence: entry.metadata.ai.confidence || 0,
    });
  } catch (error) {
    log.error({ err: error }, 'get enrichment status failed');
    return NextResponse.json(
      { error: 'Failed to get enrichment status' },
      { status: 500 }
    );
  }
}
