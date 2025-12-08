import { getFileByPath } from '@/lib/db/files';
import { listDigestsForPath } from '@/lib/db/digests';
import type { DigestStatus, Digest } from '@/types';

export interface DigestStageStatus {
  /** Digester name (e.g., 'url-crawl-content', 'tags') */
  digester: string;
  status: 'to-do' | 'in-progress' | 'success' | 'failed' | 'skipped';
  error: string | null;
  updatedAt: string | null;
}

export interface DigestStatusView {
  filePath: string;
  overall: DigestStatus;
  /** All digest stages for this file */
  stages: DigestStageStatus[];
  hasFailures: boolean;
  completedCount: number;
  skippedCount: number;
  totalCount: number;
  canRetry: boolean;
}

/**
 * Map digest status to stage status for UI
 */
function mapDigestStatus(status: Digest['status']): DigestStageStatus['status'] {
  switch (status) {
    case 'todo':
      return 'to-do';
    case 'in-progress':
      return 'in-progress';
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'to-do';
  }
}

/**
 * Derive overall enrichment status from digest statuses
 */
function deriveOverallStatus(digests: Digest[]): DigestStatus {
  if (digests.length === 0) return 'todo';

  const hasInProgress = digests.some(d => d.status === 'in-progress');
  const hasFailed = digests.some(d => d.status === 'failed');
  const allTerminal = digests.every(d =>
    d.status === 'completed' || d.status === 'skipped' || d.status === 'failed'
  );

  if (hasInProgress) return 'in-progress';
  if (hasFailed) return 'failed';
  if (allTerminal) return 'completed';
  return 'todo';
}

/**
 * Summarize digest enrichment status for a file
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/photo.jpg')
 * @param digests - List of digests for this file
 */
export function summarizeDigestEnrichment(
  filePath: string,
  digests: Digest[]
): DigestStatusView {
  // Convert all digests to stages (no filtering)
  const stages: DigestStageStatus[] = digests.map((d) => ({
    digester: d.digester,
    status: mapDigestStatus(d.status),
    error: d.error,
    updatedAt: d.updatedAt,
  }));

  const totalCount = stages.length;
  const completedCount = stages.filter((s) => s.status === 'success').length;
  const skippedCount = stages.filter((s) => s.status === 'skipped').length;
  const hasFailures = stages.some((s) => s.status === 'failed');
  const canRetry = hasFailures;

  return {
    filePath,
    overall: deriveOverallStatus(digests),
    stages,
    hasFailures,
    completedCount,
    skippedCount,
    totalCount,
    canRetry,
  };
}

/**
 * Get digest status view for a file path
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/photo.jpg')
 */
export function getDigestStatusView(filePath: string): DigestStatusView | null {
  const file = getFileByPath(filePath);
  if (!file) return null;

  // Load digests for this file
  const digests = listDigestsForPath(filePath, { order: 'asc' });
  return summarizeDigestEnrichment(filePath, digests);
}
