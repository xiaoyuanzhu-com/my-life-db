import { getFileByPath } from '@/lib/db/files';
import { listDigestsForPath } from '@/lib/db/digests';
import type { EnrichmentStatus, Digest } from '@/types';

export interface InboxStageStatus {
  taskType: string;
  status: 'to-do' | 'in-progress' | 'success' | 'failed';
  error: string | null;
  updatedAt: string | null;
}

export interface DigestStatusView {
  filePath: string;
  overall: EnrichmentStatus;
  stages: InboxStageStatus[];
  hasFailures: boolean;
  completedCount: number;
  totalCount: number;
  // Derived hints for UI
  crawlDone: boolean;
  summaryDone: boolean;
  screenshotReady: boolean;
  tagsReady: boolean;
  slugReady: boolean;
  canRetry: boolean;
}

// Map digest types to task types
const DIGEST_TYPE_TO_TASK_TYPE: Record<string, string> = {
  'content-md': 'digest_url_crawl',
  'summary': 'digest_url_summary',
  'tags': 'digest_url_tagging',
  'slug': 'digest_url_slug',
};

// Map digest status to task status
function mapDigestStatus(status: Digest['status']): InboxStageStatus['status'] {
  switch (status) {
    case 'pending':
      return 'to-do';
    case 'enriching':
      return 'in-progress';
    case 'enriched':
      return 'success';
    case 'failed':
      return 'failed';
    default:
      return 'to-do';
  }
}

/**
 * Derive overall enrichment status from digest statuses
 */
function deriveOverallStatus(digests: Digest[]): EnrichmentStatus {
  if (digests.length === 0) return 'pending';

  const hasInProgress = digests.some(d => d.status === 'enriching');
  const hasFailed = digests.some(d => d.status === 'failed');
  const allEnriched = digests.every(d => d.status === 'enriched');

  if (hasFailed) return 'failed';
  if (hasInProgress) return 'enriching';
  if (allEnriched) return 'enriched';
  return 'pending';
}

/**
 * Summarize digest enrichment status for a file
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 * @param digests - List of digests for this file
 */
export function summarizeDigestEnrichment(
  filePath: string,
  digests: Digest[]
): DigestStatusView {
  // Convert digests to stages
  const stages: InboxStageStatus[] = digests
    .filter((d) => DIGEST_TYPE_TO_TASK_TYPE[d.digestType])
    .map((d) => ({
      taskType: DIGEST_TYPE_TO_TASK_TYPE[d.digestType],
      status: mapDigestStatus(d.status),
      error: d.error,
      updatedAt: d.updatedAt,
    }));

  // Ensure all 4 digest types are present (create to-do placeholders for missing)
  const EXPECTED_DIGEST_TYPES = ['content-md', 'summary', 'tags', 'slug'];
  for (const digestType of EXPECTED_DIGEST_TYPES) {
    const taskType = DIGEST_TYPE_TO_TASK_TYPE[digestType];
    if (!stages.find((s) => s.taskType === taskType)) {
      stages.push({
        taskType,
        status: 'to-do',
        error: null,
        updatedAt: null,
      });
    }
  }

  // Sort stages in expected order
  const stageOrder = ['digest_url_crawl', 'digest_url_summary', 'digest_url_tagging', 'digest_url_slug'];
  stages.sort((a, b) => stageOrder.indexOf(a.taskType) - stageOrder.indexOf(b.taskType));

  // Derive booleans from digests
  const contentMdDigest = digests.find((d) => d.digestType === 'content-md');
  const summaryDigest = digests.find((d) => d.digestType === 'summary');
  const tagsDigest = digests.find((d) => d.digestType === 'tags');
  const slugDigest = digests.find((d) => d.digestType === 'slug');
  const screenshotDigest = digests.find((d) => d.digestType === 'screenshot');

  const crawlStage = stages.find((s) => s.taskType === 'digest_url_crawl');
  const crawlDone = Boolean(
    crawlStage?.status === 'success' || contentMdDigest?.status === 'enriched'
  );
  const summaryStage = stages.find((s) => s.taskType === 'digest_url_summary');
  const summaryDone = Boolean(
    summaryStage?.status === 'success' || summaryDigest?.status === 'enriched'
  );
  const screenshotReady = Boolean(screenshotDigest?.status === 'enriched');
  const taggingStage = stages.find((s) => s.taskType === 'digest_url_tagging');
  const tagsReady = Boolean(taggingStage?.status === 'success' || tagsDigest?.status === 'enriched');
  const slugStage = stages.find((s) => s.taskType === 'digest_url_slug');
  const slugReady = Boolean(
    slugStage?.status === 'success' || slugDigest?.status === 'enriched'
  );

  const totalCount = stages.length;
  const completedCount = stages.filter((s) => s.status === 'success').length;
  const hasFailures = stages.some((s) => s.status === 'failed');
  const canRetry = hasFailures;

  return {
    filePath,
    overall: deriveOverallStatus(digests),
    stages,
    hasFailures,
    completedCount,
    totalCount,
    crawlDone,
    summaryDone,
    screenshotReady,
    tagsReady,
    slugReady,
    canRetry,
  };
}

/**
 * Get digest status view for a file path
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 */
export function getDigestStatusView(filePath: string): DigestStatusView | null {
  const file = getFileByPath(filePath);
  if (!file) return null;

  // Load digests for this file
  const digests = listDigestsForPath(filePath);
  return summarizeDigestEnrichment(filePath, digests);
}
