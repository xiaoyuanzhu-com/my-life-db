import { getInboxItemById } from '@/lib/db/inbox';
import { getInboxTaskStates } from '@/lib/db/inboxTaskState';
import type { EnrichmentStatus, InboxItem } from '@/types';
import type { InboxTaskState } from '@/lib/db/inboxTaskState';

export interface InboxStageStatus {
  taskType: string;
  status: 'to-do' | 'in-progress' | 'success' | 'failed';
  attempts: number;
  error: string | null;
  updatedAt: number | null;
}

export interface InboxStatusView {
  inboxId: string;
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

export function summarizeInboxEnrichment(
  inbox: InboxItem,
  states: InboxTaskState[]
): InboxStatusView {
  const stages: InboxStageStatus[] = states.map((s) => ({
    taskType: s.task_type,
    status: s.status,
    attempts: s.attempts,
    error: s.error,
    updatedAt: s.updated_at,
  }));

  // Derive booleans from files where possible
  const hasContentMd = inbox.files.some((f) =>
    f.filename === 'content.md' || f.filename === 'digest/content.md'
  );
  const hasContentHtml = inbox.files.some((f) =>
    f.filename === 'content.html' || f.filename === 'digest/content.html'
  );
  const hasMainContent = inbox.files.some((f) =>
    f.filename === 'main-content.md' || f.filename === 'digest/main-content.md'
  );
  const hasScreenshot = inbox.files.some((f) =>
    f.filename === 'screenshot.png' ||
    f.filename === 'screenshot.jpg' ||
    f.filename === 'digest/screenshot.png' ||
    f.filename === 'digest/screenshot.jpg'
  );
  const hasSummary = inbox.files.some((f) =>
    f.filename === 'summary.md' || f.filename === 'digest/summary.md'
  );
  const hasTags = inbox.files.some((f) =>
    f.filename === 'tags.json' || f.filename === 'digest/tags.json'
  );
  const hasSlug = inbox.files.some((f) => f.filename === 'digest/slug.json');

  const crawlStage = stages.find((s) => s.taskType === 'digest_url_crawl');
  const crawlDone = Boolean(crawlStage?.status === 'success' || hasContentMd || hasContentHtml);
  const summaryStage = stages.find((s) => s.taskType === 'digest_url_summary');
  const summaryDone = Boolean(
    summaryStage?.status === 'success' || hasSummary || inbox.aiSlug || hasMainContent
  );
  const screenshotReady = Boolean(hasScreenshot);
  const taggingStage = stages.find((s) => s.taskType === 'digest_url_tagging');
  const tagsReady = Boolean(taggingStage?.status === 'success' || hasTags);
  const slugStage = stages.find((s) => s.taskType === 'digest_url_slug');
  const slugReady = Boolean(slugStage?.status === 'success' || hasSlug || inbox.aiSlug);

  const totalCount = stages.length;
  const completedCount = stages.filter((s) => s.status === 'success').length;
  const hasFailures = stages.some((s) => s.status === 'failed');
  const canRetry = hasFailures;

  return {
    inboxId: inbox.id,
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

export function getInboxStatusView(inboxId: string): InboxStatusView | null {
  const inbox = getInboxItemById(inboxId);
  if (!inbox) return null;

  // Load stage states from projection
  const states = getInboxTaskStates(inboxId);
  return summarizeInboxEnrichment(inbox, states);
}
