import type { Entry, EntryMetadata, ExtractionOptions } from '@/types';
import { extractTextInfo } from './extractors/textExtractor';
import { extractImageInfo } from './extractors/imageExtractor';
import path from 'path';

/**
 * Main AI processor that coordinates all extraction services
 * Processes entries and their attachments to extract structured information
 */
export async function processEntry(
  entry: Entry,
  options: ExtractionOptions = {}
): Promise<EntryMetadata> {
  const metadata = { ...entry.metadata };

  try {
    // Extract information from text content
    if (entry.content && entry.content.trim().length > 0) {
      const textExtraction = await extractTextInfo(entry.content, options);

      // Update AI metadata with extraction results
      metadata.ai = {
        ...metadata.ai,
        processed: true,
        processedAt: new Date().toISOString(),
        title: textExtraction.title,
        tags: textExtraction.tags,
        summary: textExtraction.summary,
        confidence: textExtraction.confidence,
        entities: textExtraction.entities,
        category: textExtraction.category,
        sentiment: textExtraction.sentiment,
        priority: textExtraction.priority,
        mood: textExtraction.mood,
        actionItems: textExtraction.actionItems,
      };

      // Update top-level tags with AI tags
      metadata.tags = [...new Set([...metadata.tags, ...textExtraction.tags])];
    }

    // Process attachments
    if (metadata.attachments && metadata.attachments.length > 0) {
      for (let i = 0; i < metadata.attachments.length; i++) {
        const attachment = metadata.attachments[i];

        // Process images
        if (attachment.mimeType.startsWith('image/')) {
          const imagePath = path.join(entry.directoryPath, attachment.filename);
          const imageExtraction = await extractImageInfo(imagePath, attachment.mimeType);

          // Update attachment AI data
          metadata.attachments[i].ai = {
            caption: imageExtraction.caption ?? undefined,
            ocr: imageExtraction.ocrText ?? undefined,
          };

          // Add image tags to entry tags
          if (imageExtraction.tags.length > 0) {
            metadata.tags = [...new Set([...metadata.tags, ...imageExtraction.tags])];
          }
        }

        // TODO: Process audio files (transcription)
        // TODO: Process PDFs (text extraction)
        // TODO: Process video files (frame analysis, transcription)
      }
    }

    // Find related entries (if option enabled)
    if (options.includeRelatedEntries) {
      metadata.ai.relatedEntryIds = await findRelatedEntries(entry);
    }

    // Suggest spaces/categories
    metadata.ai.suggestedSpaces = await suggestSpaces(entry, metadata);

    // Update the timestamp
    metadata.updatedAt = new Date().toISOString();

    return metadata;
  } catch (error) {
    console.error('Error processing entry:', error);

    // Mark as processed but with error
    metadata.ai = {
      ...metadata.ai,
      processed: false,
      processedAt: new Date().toISOString(),
    };

    return metadata;
  }
}

/**
 * Batch process multiple entries
 */
export async function batchProcessEntries(
  entries: Entry[],
  options: ExtractionOptions = {}
): Promise<Map<string, EntryMetadata>> {
  const results = new Map<string, EntryMetadata>();

  // Process entries in parallel (with concurrency limit)
  const BATCH_SIZE = 5;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        const metadata = await processEntry(entry, options);
        return { id: entry.metadata.id, metadata };
      })
    );

    batchResults.forEach(({ id, metadata }) => {
      results.set(id, metadata);
    });
  }

  return results;
}

/**
 * Find related entries using similarity search
 */
async function findRelatedEntries(_entry: Entry): Promise<string[]> {
  // TODO: Implement vector similarity search using embeddings
  // This would:
  // 1. Generate embedding for current entry
  // 2. Search for similar entries in vector DB
  // 3. Return top N most similar entry IDs

  return [];
}

/**
 * Suggest spaces/categories for the entry
 */
async function suggestSpaces(entry: Entry, metadata: EntryMetadata): Promise<string[]> {
  // TODO: Implement space suggestion based on:
  // 1. Extracted tags
  // 2. Category classification
  // 3. Similarity to existing spaces
  // 4. User's organizational patterns

  const suggestions: string[] = [];

  // Basic rule-based suggestions based on category
  if (metadata.ai.category) {
    suggestions.push(metadata.ai.category);
  }

  // Add suggestions based on top tags
  if (metadata.ai.tags && metadata.ai.tags.length > 0) {
    suggestions.push(...metadata.ai.tags.slice(0, 2));
  }

  return suggestions;
}

/**
 * Re-process an entry (for when AI models improve or user requests refresh)
 */
export async function reprocessEntry(
  entry: Entry,
  options: ExtractionOptions = {}
): Promise<EntryMetadata> {
  // Force reprocessing even if already processed
  return processEntry(entry, options);
}

/**
 * Get processing status for an entry
 */
export function getProcessingStatus(metadata: EntryMetadata): {
  processed: boolean;
  processedAt: string | null;
  hasTitle: boolean;
  hasSummary: boolean;
  hasTags: boolean;
  hasEntities: boolean;
  confidence: number;
} {
  return {
    processed: metadata.ai.processed,
    processedAt: metadata.ai.processedAt,
    hasTitle: Boolean(metadata.ai.title),
    hasSummary: Boolean(metadata.ai.summary),
    hasTags: metadata.ai.tags && metadata.ai.tags.length > 0,
    hasEntities: Boolean(metadata.ai.entities && Object.values(metadata.ai.entities).some(arr => arr && arr.length > 0)),
    confidence: metadata.ai.confidence || 0,
  };
}
