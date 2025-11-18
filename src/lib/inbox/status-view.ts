import { getFileByPath } from '@/lib/db/files';
import { listDigestsForPath } from '@/lib/db/digests';
import type { DigestStatus, Digest } from '@/types';

export interface InboxStageStatus {
  taskType: string;
  status: 'to-do' | 'in-progress' | 'success' | 'failed';
  error: string | null;
  updatedAt: string | null;
}

export interface DigestStatusView {
  filePath: string;
  overall: DigestStatus;
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

// Map digesters to task types
const DIGESTER_TO_TASK_TYPE: Record<string, string> = {
  'url-crawl-content': 'digest_url_crawl',
  'summarize': 'digest_url_summary',
  'tagging': 'digest_url_tagging',
  'slug': 'digest_url_slug',
};

// Map digest status to task status
function mapDigestStatus(status: Digest['status']): InboxStageStatus['status'] {
  switch (status) {
    case 'todo':
      return 'to-do';
    case 'in-progress':
      return 'in-progress';
    case 'completed':
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
function deriveOverallStatus(digests: Digest[]): DigestStatus {
  if (digests.length === 0) return 'todo';

  const hasInProgress = digests.some(d => d.status === 'in-progress');
  const hasFailed = digests.some(d => d.status === 'failed');
  const allCompleted = digests.every(d => d.status === 'completed' || d.status === 'skipped');

  if (hasFailed) return 'failed';
  if (hasInProgress) return 'in-progress';
  if (allCompleted) return 'completed';
  return 'todo';
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
    .filter((d) => DIGESTER_TO_TASK_TYPE[d.digester])
    .map((d) => ({
      taskType: DIGESTER_TO_TASK_TYPE[d.digester],
      status: mapDigestStatus(d.status),
      error: d.error,
      updatedAt: d.updatedAt,
    }));

  // Ensure all 4 digest types are present (create to-do placeholders for missing)
  const EXPECTED_DIGESTERS = ['url-crawl-content', 'summarize', 'tagging', 'slug'];
  for (const digester of EXPECTED_DIGESTERS) {
    const taskType = DIGESTER_TO_TASK_TYPE[digester];
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
  const contentDigest = digests.find((d) => d.digester === 'url-crawl-content');
  const summaryDigest = digests.find((d) => d.digester === 'summarize');
  const tagsDigest = digests.find((d) => d.digester === 'tagging');
  const slugDigest = digests.find((d) => d.digester === 'slug');
  const screenshotDigest = digests.find((d) => d.digester === 'url-crawl-screenshot');

  const crawlStage = stages.find((s) => s.taskType === 'digest_url_crawl');
  const crawlDone = Boolean(
    crawlStage?.status === 'success' || contentDigest?.status === 'completed'
  );
  const summaryStage = stages.find((s) => s.taskType === 'digest_url_summary');
  const summaryDone = Boolean(
    summaryStage?.status === 'success' || summaryDigest?.status === 'completed'
  );
  const screenshotReady = Boolean(screenshotDigest?.status === 'completed');
  const taggingStage = stages.find((s) => s.taskType === 'digest_url_tagging');
  const tagsReady = Boolean(taggingStage?.status === 'success' || tagsDigest?.status === 'completed');
  const slugStage = stages.find((s) => s.taskType === 'digest_url_slug');
  const slugReady = Boolean(
    slugStage?.status === 'success' || slugDigest?.status === 'completed'
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
  const digests = listDigestsForPath(filePath, { order: 'asc' });
  return summarizeDigestEnrichment(filePath, digests);
}
