import { getInboxItemById } from '@/lib/db/inbox';
import { listDigestsForItem } from '@/lib/db/digests';
import type { EnrichmentStatus, InboxItem, Digest } from '@/types';

export interface InboxStageStatus {
  taskType: string;
  status: 'to-do' | 'in-progress' | 'success' | 'failed';
  error: string | null;
  updatedAt: string | null;
}

export interface InboxStatusView {
  itemId: string;
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

export function summarizeInboxEnrichment(
  inbox: InboxItem,
  digests: Digest[]
): InboxStatusView {
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
    crawlStage?.status === 'success' || contentMdDigest?.status === 'completed'
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
    itemId: inbox.id,
    overall: inbox.status,
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

export function getInboxStatusView(itemId: string): InboxStatusView | null {
  const inbox = getInboxItemById(itemId);
  if (!inbox) return null;

  // Load digests directly from digests table
  const digests = listDigestsForItem(itemId);
  return summarizeInboxEnrichment(inbox, digests);
}
