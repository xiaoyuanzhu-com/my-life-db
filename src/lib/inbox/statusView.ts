import { getInboxItemById } from '@/lib/db/inbox';
import { getInboxTaskStates } from '@/lib/db/inboxTaskState';
import type { ProcessingStatus, InboxItem } from '@/types';
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
  overall: ProcessingStatus;
  stages: InboxStageStatus[];
  hasFailures: boolean;
  completedCount: number;
  totalCount: number;
  // Derived hints for UI
  crawlDone: boolean;
  summaryDone: boolean;
  screenshotReady: boolean;
  canRetry: boolean;
}

export function summarizeInboxProcessing(
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
  const hasContentMd = inbox.files.some((f) => f.filename === 'content.md');
  const hasContentHtml = inbox.files.some((f) => f.filename === 'content.html');
  const hasMainContent = inbox.files.some((f) => f.filename === 'main-content.md');
  const hasScreenshot = inbox.files.some((f) => f.filename === 'screenshot.png' || f.filename === 'screenshot.jpg');

  const crawlStage = stages.find((s) => s.taskType === 'process_url');
  const crawlDone = Boolean(crawlStage?.status === 'success' || hasContentMd || hasContentHtml);
  const summaryDone = Boolean(inbox.aiSlug || hasMainContent);
  const screenshotReady = Boolean(hasScreenshot);

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
    canRetry,
  };
}

export function getInboxStatusView(inboxId: string): InboxStatusView | null {
  const inbox = getInboxItemById(inboxId);
  if (!inbox) return null;

  // Load stage states from projection
  const states = getInboxTaskStates(inboxId);
  return summarizeInboxProcessing(inbox, states);
}
