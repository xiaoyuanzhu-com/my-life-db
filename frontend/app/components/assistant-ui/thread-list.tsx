import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  Loader2Icon,
  MoreHorizontalIcon,
} from "lucide-react";
import { type FC, useEffect, useRef } from "react";
import { cn } from "~/lib/utils";

type SessionState = 'idle' | 'working' | 'unread' | 'archived';

interface ThreadListProps {
  activeSessionId?: string | null;
  /** Map of session ID → sessionState, used to render status dots */
  sessionStates?: Record<string, SessionState>;
  /** Map of session ID → source, used to render "auto" badge */
  sessionSources?: Record<string, string>;
  /** Map of session ID → agentName, used to label auto sessions with their agent */
  sessionAgentNames?: Record<string, string>;
  /** Map of session ID → pre-formatted trigger label ("cron 10:30", "new inbox/foo.md"); auto rows only */
  sessionTriggerLabels?: Record<string, string>;
  /** Whether more sessions can be loaded */
  hasMore?: boolean;
  /** Whether more sessions are currently loading */
  isLoadingMore?: boolean;
  /** Callback to load more sessions */
  onLoadMore?: () => void;
}

export const ThreadList: FC<ThreadListProps> = ({ activeSessionId, sessionStates, sessionSources, sessionAgentNames, sessionTriggerLabels, hasMore, isLoadingMore, onLoadMore }) => {
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !onLoadMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !isLoadingMore) {
          onLoadMore()
        }
      },
      { threshold: 0 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, isLoadingMore, onLoadMore])

  return (
    <ThreadListPrimitive.Root className="aui-root aui-thread-list-root relative flex flex-1 min-h-0 flex-col gap-0.5 overflow-y-auto">
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListPrimitive.Items>
          {() => <ThreadListItem activeSessionId={activeSessionId} sessionStates={sessionStates} sessionSources={sessionSources} sessionAgentNames={sessionAgentNames} sessionTriggerLabels={sessionTriggerLabels} />}
        </ThreadListPrimitive.Items>
        <ThreadListPrimitive.Items archived>
          {() => <ThreadListItem activeSessionId={activeSessionId} sessionStates={sessionStates} sessionSources={sessionSources} sessionAgentNames={sessionAgentNames} sessionTriggerLabels={sessionTriggerLabels} />}
        </ThreadListPrimitive.Items>
        {/* Scroll sentinel for infinite loading */}
        <div ref={sentinelRef} className="shrink-0 h-1" />
        {isLoadingMore && (
          <div className="flex items-center justify-center py-2">
            <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
      </AuiIf>
    </ThreadListPrimitive.Root>
  );
};


const ThreadListSkeleton: FC = () => {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          role="status"
          aria-label="Loading threads"
          className="aui-thread-list-skeleton-wrapper flex h-9 items-center px-3"
        >
          <Skeleton className="aui-thread-list-skeleton h-4 w-full" />
        </div>
      ))}
    </div>
  );
};

const ThreadListItem: FC<{ activeSessionId?: string | null; sessionStates?: Record<string, SessionState>; sessionSources?: Record<string, string>; sessionAgentNames?: Record<string, string>; sessionTriggerLabels?: Record<string, string> }> = ({ activeSessionId, sessionStates, sessionSources, sessionAgentNames, sessionTriggerLabels }) => {
  // Workaround: assistant-ui's ExternalStoreThreadListRuntimeCore has a bug where
  // _mainThreadId is not set from the adapter's threadId on initial construction
  // (constructor sets this.adapter before calling __internal_setAdapter, so
  // previousThreadId === newThreadId and the update is skipped). This means
  // data-active is not set on direct URL navigation. We read the item's ID from
  // the store and set data-active ourselves. ThreadListItemPrimitive.Root spreads
  // {...props} AFTER its own data-active, so our prop takes precedence.
  const itemId = useAuiState((s) => s.threadListItem.id);
  const isActive = itemId != null && itemId === activeSessionId;

  // Show status dot for working/unread sessions that aren't currently active
  const sessionState = itemId ? sessionStates?.[itemId] : undefined;
  const isArchived = sessionState === 'archived';
  const showDot = !isActive && (sessionState === 'working' || sessionState === 'unread');
  const isAuto = itemId ? sessionSources?.[itemId] === 'auto' : false;
  const agentName = itemId ? sessionAgentNames?.[itemId] : undefined;
  const triggerLabel = itemId ? sessionTriggerLabels?.[itemId] : undefined;
  // Auto rows with a trigger label use a different layout: the agent name
  // leads as a pill, followed by the per-run trigger label as the main
  // text. This gives each run a unique, informative label instead of the
  // static session title, which is always "Run <agent>" for auto agents.
  const useAutoLayout = isAuto && !!triggerLabel;

  return (
    <ThreadListItemPrimitive.Root
      {...(isActive ? { "data-active": "true" } : {})}
      className="aui-thread-list-item group flex h-8 items-center gap-1 rounded-md transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none data-active:bg-muted"
    >
      <ThreadListItemPrimitive.Trigger className="aui-thread-list-item-trigger flex h-full min-w-0 flex-1 items-center px-2.5 text-start text-[13px]">
        {useAutoLayout ? (
          <>
            {agentName && (
              <span
                className="shrink-0 text-[10px] leading-none px-1.5 py-0.5 rounded bg-muted text-muted-foreground truncate max-w-[40%] mr-1.5"
                title={agentName}
              >
                {agentName}
              </span>
            )}
            <span
              className={cn(
                "aui-thread-list-item-title min-w-0 flex-1 truncate group-data-active:text-foreground",
                isArchived ? "text-foreground/40" : "text-foreground/80"
              )}
              title={triggerLabel}
            >
              {triggerLabel}
            </span>
          </>
        ) : (
          <>
            <span className={cn(
              "aui-thread-list-item-title min-w-0 flex-1 truncate group-data-active:text-foreground",
              isArchived ? "text-foreground/40" : "text-foreground/80"
            )}>
              <ThreadListItemPrimitive.Title fallback="New Chat" />
            </span>
            {isAuto && agentName && (
              <span
                className="shrink-0 text-[10px] leading-none px-1.5 py-0.5 rounded bg-muted text-muted-foreground truncate max-w-[40%]"
                title={agentName}
              >
                {agentName}
              </span>
            )}
            {isAuto && !agentName && (
              <span className="shrink-0 text-[10px] leading-none px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                auto
              </span>
            )}
          </>
        )}
        {/* Fixed-width dot column — keeps dots vertically aligned across rows */}
        <span className="w-2 shrink-0 flex items-center ml-1">
          {showDot && (
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                sessionState === 'working' ? 'bg-amber-500' : 'bg-emerald-500'
              )}
              title={sessionState === 'working' ? 'Agent is working' : 'New messages — waiting for you'}
            />
          )}
        </span>
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemMore isArchived={isArchived} />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemMore: FC<{ isArchived?: boolean }> = ({ isArchived }) => {
  const aui = useAui();
  const handleUnarchive = () => aui.threadListItem().unarchive();

  return (
    <ThreadListItemMorePrimitive.Root>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="aui-thread-list-item-more mr-1.5 size-6 p-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:bg-accent data-[state=open]:opacity-100 group-data-active:opacity-100"
        >
          <MoreHorizontalIcon className="size-4" />
          <span className="sr-only">More options</span>
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="bottom"
        align="start"
        className="aui-thread-list-item-more-content z-50 min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      >
        {isArchived ? (
          <ThreadListItemMorePrimitive.Item
            onClick={handleUnarchive}
            className="aui-thread-list-item-more-item flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <ArchiveRestoreIcon className="size-4" />
            Unarchive
          </ThreadListItemMorePrimitive.Item>
        ) : (
          <ThreadListItemPrimitive.Archive asChild>
            <ThreadListItemMorePrimitive.Item className="aui-thread-list-item-more-item flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground">
              <ArchiveIcon className="size-4" />
              Archive
            </ThreadListItemMorePrimitive.Item>
          </ThreadListItemPrimitive.Archive>
        )}
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
