import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import type { FC } from "react";

export const ThreadList: FC<{ activeSessionId?: string | null }> = ({ activeSessionId }) => {
  return (
    <ThreadListPrimitive.Root className="aui-root aui-thread-list-root flex flex-col gap-0.5 overflow-y-auto">
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListPrimitive.Items>
          {() => <ThreadListItem activeSessionId={activeSessionId} />}
        </ThreadListPrimitive.Items>
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

const ThreadListItem: FC<{ activeSessionId?: string | null }> = ({ activeSessionId }) => {
  // Workaround: assistant-ui's ExternalStoreThreadListRuntimeCore has a bug where
  // _mainThreadId is not set from the adapter's threadId on initial construction
  // (constructor sets this.adapter before calling __internal_setAdapter, so
  // previousThreadId === newThreadId and the update is skipped). This means
  // data-active is not set on direct URL navigation. We read the item's ID from
  // the store and set data-active ourselves. ThreadListItemPrimitive.Root spreads
  // {...props} AFTER its own data-active, so our prop takes precedence.
  const itemId = useAuiState((s) => s.threadListItem.id);
  const isActive = itemId != null && itemId === activeSessionId;

  return (
    <ThreadListItemPrimitive.Root
      {...(isActive ? { "data-active": "true" } : {})}
      className="aui-thread-list-item group flex h-8 items-center gap-1 rounded-md transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none data-active:bg-muted"
    >
      <ThreadListItemPrimitive.Trigger className="aui-thread-list-item-trigger flex h-full min-w-0 flex-1 items-center px-2.5 text-start text-[13px]">
        <span className="aui-thread-list-item-title min-w-0 flex-1 truncate text-foreground/80 group-data-active:text-foreground">
          <ThreadListItemPrimitive.Title fallback="New Chat" />
        </span>
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemMore />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemMore: FC = () => {
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
        <ThreadListItemPrimitive.Archive asChild>
          <ThreadListItemMorePrimitive.Item className="aui-thread-list-item-more-item flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground">
            <ArchiveIcon className="size-4" />
            Archive
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Archive>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
