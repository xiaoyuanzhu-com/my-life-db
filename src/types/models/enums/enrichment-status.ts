/**
 * Enrichment Status - tracks AI processing state for files and digests
 *
 * Lifecycle: pending → enriching → enriched (or failed/skipped)
 *
 * Values:
 * - pending: Queued for processing, not started yet
 * - enriching: Currently being processed by AI
 * - enriched: Successfully processed and enriched
 * - failed: Processing failed (see error field)
 * - skipped: Intentionally skipped (not applicable for this file)
 */
export type EnrichmentStatus = 'pending' | 'enriching' | 'enriched' | 'failed' | 'skipped';
