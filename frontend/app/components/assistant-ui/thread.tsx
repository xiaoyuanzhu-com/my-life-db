import { TooltipIconButton } from "~/components/assistant-ui/tooltip-icon-button";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Popover, PopoverContent } from "~/components/ui/popover";
import {
  AuiIf,
  ComposerPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useComposer,
  useComposerRuntime,
  useMessage,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Plus,
  SquareIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import type { PlanEntry } from "~/hooks/use-agent-runtime";
import { useHasTouch } from "~/hooks/use-has-touch";

// Our custom message components (with tool dispatch, markdown, reasoning, etc.)
import { createAssistantMessage } from "~/components/agent/assistant-message";
import { UserMessage as AcpUserMessage } from "~/components/agent/user-message";
import { acpToolsConfig } from "~/components/agent/tool-dispatch";
import { ConnectionStatusBanner } from "~/components/agent/connection-status-banner";
import { PlanView } from "~/components/agent/plan-view";
import { AgentWIP } from "~/components/agent/agent-wip";
import { PermissionCard } from "~/components/agent/permission-card";
import { FolderPicker } from "~/components/agent/folder-picker";
import { AgentTypeSelector, type AgentType } from "~/components/agent/agent-type-selector";
import { ConfigOptionSelector } from "~/components/agent/config-option-selector";
import { SlashCommandPopover } from "~/components/agent/slash-command-popover";
import { FileTagPopover } from "~/components/agent/file-tag-popover";
import { ChangedFilesPopover } from "~/components/agent/changed-files-popover";
import { useAgentContext } from "~/components/agent/agent-context";

// Create the AssistantMessage with our ACP tool renderers baked in
const AcpAssistantMessage = createAssistantMessage(acpToolsConfig);

export const Thread: FC = () => {
  const { pendingPermissions, hasActiveSession, historyLoadError, sessionError } = useAgentContext();
  const hasSession = useAuiState((s) => !s.thread.isEmpty);
  const isRunning = useAuiState((s) => s.thread.isRunning);

  // Show loading when we have an active session but messages haven't loaded into the store yet.
  // Covers both "WS connecting" and "WS connected, replay in progress".
  // Stop loading if the backend reported that history loading failed.
  const isLoadingSession = hasActiveSession && !hasSession && !historyLoadError && !sessionError;
  const isHistoryError = hasActiveSession && !hasSession && !!historyLoadError;
  const isSessionError = hasActiveSession && !hasSession && !!sessionError;

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container flex h-full flex-col bg-background"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-radius" as string]: "12px",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        autoScroll
        className="aui-thread-viewport relative flex flex-1 flex-col overflow-x-hidden overflow-y-scroll scroll-smooth px-2 md:px-16 pt-4"
      >
        {isLoadingSession ? (
          <ThreadLoading />
        ) : isHistoryError ? (
          <ThreadHistoryError message={historyLoadError!} />
        ) : isSessionError ? (
          <ThreadSessionError message={sessionError!} />
        ) : (
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <ThreadWelcome />
          </AuiIf>
        )}
        <InitialScrollToBottom />

        <ThreadPrimitive.Messages className="mx-auto w-full max-w-(--thread-max-width)">
          {() => <ThreadMessage />}
        </ThreadPrimitive.Messages>

        {isRunning && pendingPermissions.size === 0 && <AgentWIP />}

        <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto flex w-full max-w-(--thread-max-width) flex-col overflow-visible">
          <ThreadScrollToBottom />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 md:px-16 pb-4 md:pb-6">
        <Composer />
      </div>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const message = useMessage();
  const planEntries = (message as { metadata?: { custom?: { planEntries?: PlanEntry[] } } }).metadata?.custom?.planEntries;
  if (planEntries && planEntries.length > 0) {
    return (
      <div className="mb-4">
        <PlanView entries={planEntries} />
      </div>
    );
  }
  if (role === "user") return <AcpUserMessage />;
  return <AcpAssistantMessage />;
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible dark:border-border dark:bg-background dark:hover:bg-accent"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

/**
 * Scrolls the viewport to bottom as content loads during initial WS replay.
 * Uses MutationObserver to detect DOM changes (new messages being inserted).
 * ResizeObserver doesn't work here because the viewport's own dimensions don't
 * change when content is added inside a scrollable container — only scrollHeight does.
 * Auto-disconnects once content stops changing (replay settled).
 */
const InitialScrollToBottom: FC = () => {
  const anchorRef = useRef<HTMLDivElement>(null);
  const { hasActiveSession } = useAgentContext();
  const hasSession = useAuiState((s) => !s.thread.isEmpty);

  useEffect(() => {
    if (!hasSession || !hasActiveSession) return;

    const viewport = anchorRef.current?.closest(
      '.aui-thread-viewport',
    ) as HTMLElement | null;
    if (!viewport) return;

    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const scrollToEnd = () => {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' });
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => observer.disconnect(), 500);
    };

    const observer = new MutationObserver(scrollToEnd);
    observer.observe(viewport, { childList: true, subtree: true });

    // Initial scroll in case content is already rendered
    scrollToEnd();

    return () => {
      observer.disconnect();
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [hasSession, hasActiveSession]);

  return <div ref={anchorRef} aria-hidden style={{ display: 'none' }} />;
};

const ThreadLoading: FC = () => {
  return (
    <div className="mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center">
      <p className="text-muted-foreground text-sm">Loading...</p>
    </div>
  );
};

const ThreadHistoryError: FC<{ message: string }> = ({ message }) => {
  return (
    <div className="mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center gap-2">
      <p className="text-muted-foreground text-sm">Session history unavailable</p>
      <p className="text-muted-foreground/60 text-xs max-w-sm text-center">{message}</p>
      <p className="text-muted-foreground/60 text-xs">You can still send a new message to continue this session.</p>
    </div>
  );
};

const ThreadSessionError: FC<{ message: string }> = ({ message }) => {
  return (
    <div className="mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center gap-2">
      <p className="text-muted-foreground text-sm">Session failed</p>
      <p className="text-muted-foreground/60 text-xs max-w-sm text-center break-words">{message}</p>
      <p className="text-muted-foreground/60 text-xs">You can start a new session or retry with a new message.</p>
    </div>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center">
      <p className="text-muted-foreground text-sm">Start a conversation</p>
    </div>
  );
};

/** Stop button that directly calls cancelRun on the thread runtime.
 * ComposerPrimitive.Cancel gates on canCancel which can be unreliable
 * with external store runtimes, so we bypass it entirely. */
const StopButton: FC = () => {
  const aui = useAui();
  return (
    <Button
      type="button"
      variant="default"
      size="icon"
      className="aui-composer-cancel size-8 rounded-full"
      aria-label="Stop generating"
      onClick={() => aui.thread().cancelRun()}
    >
      <SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
    </Button>
  );
};

/**
 * DraftPersistenceSync — bidirectional sync between composer text and localStorage.
 *
 * Saves: persists composer text as-you-type so it survives refresh/navigation.
 * Restores: on mount, restores from localStorage; on failed send, restores from
 *           pendingComposerText signalled by the runtime.
 * Clears: localStorage is cleared immediately on send (in onNew) and again
 *         when user_message_chunk confirms receipt (belt-and-suspenders).
 *
 * IMPORTANT: composerRuntime is accessed via a ref (not as an effect dependency)
 * to prevent the restore effect from re-firing when the ExternalStoreAdapter
 * rebuilds. The adapter rebuilds on every message/isRunning change, which would
 * cause the restore to read a stale localStorage value and overwrite the
 * composer text the user is actively typing.
 */
const DraftPersistenceSync: FC = () => {
  const composerRuntime = useComposerRuntime();
  const text = useComposer((s) => s.text);
  const { sessionId, pendingComposerText, clearPendingComposerText } = useAgentContext();

  const storageKey = sessionId ? `agent-input:${sessionId}` : "agent-input:new-session";

  // Stable ref to composerRuntime — avoids triggering restore when the
  // runtime reference changes (which happens when the adapter rebuilds).
  const composerRef = useRef(composerRuntime);
  composerRef.current = composerRuntime;

  // Whether the initial restore for the current storageKey has completed.
  // While false the persist effect is suppressed so it cannot wipe the
  // draft from localStorage before the deferred setTimeout restores it.
  const hasRestoredRef = useRef(false);

  // Restore from localStorage when session changes (mount, navigation).
  // Deferred via setTimeout so it runs AFTER assistant-ui's internal
  // thread-switch reset, which would otherwise overwrite our setText.
  useEffect(() => {
    hasRestoredRef.current = false;
    const draft = localStorage.getItem(storageKey);
    if (draft) {
      const timer = setTimeout(() => {
        composerRef.current.setText(draft);
        hasRestoredRef.current = true;
      }, 0);
      return () => {
        clearTimeout(timer);
        hasRestoredRef.current = false;
      };
    } else {
      hasRestoredRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- composerRuntime
    // accessed via ref; adding it here causes the race condition this fixes.
  }, [storageKey]);

  // Persist as-you-type. Suppressed until the restore phase completes and
  // when storageKey just changed (text may be stale from the previous session).
  const activeKeyRef = useRef(storageKey);
  useEffect(() => {
    if (!hasRestoredRef.current) return;
    if (activeKeyRef.current !== storageKey) {
      activeKeyRef.current = storageKey;
      return;
    }
    if (text) {
      localStorage.setItem(storageKey, text);
    } else {
      localStorage.removeItem(storageKey);
    }
  }, [text, storageKey]);

  // Restore from failed send (runtime signals via pendingComposerText)
  useEffect(() => {
    if (pendingComposerText && clearPendingComposerText) {
      composerRef.current.setText(pendingComposerText);
      clearPendingComposerText();
    }
  }, [pendingComposerText, clearPendingComposerText]);

  return null;
};

const ComposerOptionsMenu: FC = () => {
  const {
    agentType, onAgentTypeChange,
    configOptions, onConfigOptionChange,
    sessionId,
  } = useAgentContext()
  const hasActiveSession = !!sessionId

  // Stable render order: model → mode → everything else (by category)
  const CONFIG_ORDER: Record<string, number> = { model: 0, mode: 1 }
  const sortedOptions = useMemo(() => {
    if (!configOptions) return []
    return [...configOptions].sort((a, b) =>
      (CONFIG_ORDER[a.category] ?? 2) - (CONFIG_ORDER[b.category] ?? 2)
    )
  }, [configOptions])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center px-1.5 sm:px-2 py-1 sm:py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/10 cursor-pointer transition-colors shrink-0"
          title="Options"
        >
          <Plus className="h-3 w-3 sm:h-3.5 sm:w-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={4}>
        {agentType !== undefined && (
          <div className="flex items-center justify-between px-2 py-1.5 gap-4">
            <span className="text-xs text-muted-foreground shrink-0">Agent</span>
            <AgentTypeSelector
              value={agentType as AgentType}
              onChange={onAgentTypeChange ? (t) => onAgentTypeChange(t) : () => {}}
              disabled={!onAgentTypeChange || hasActiveSession}
            />
          </div>
        )}
        {sortedOptions.map((opt) => (
          <div key={opt.id} className="flex items-center justify-between px-2 py-1.5 gap-4">
            <span className="text-xs text-muted-foreground shrink-0">{opt.name}</span>
            <ConfigOptionSelector
              option={opt}
              onChange={(value) => onConfigOptionChange?.(opt.id, value)}
              disabled={!onConfigOptionChange}
            />
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const Composer: FC = () => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasTouch = useHasTouch();
  const [filesPopoverOpen, setFilesPopoverOpen] = useState(false);
  const {
    connected,
    workingDir, onWorkingDirChange,
    sessionCommands,
    sessionId,
    hasActiveSession,
    pendingPermissions,
    resultCount,
  } = useAgentContext();
  const hasSession = useAuiState((s) => !s.thread.isEmpty);
  const threadIsRunning = useAuiState((s) => s.thread.isRunning);
  const composerIsEmpty = useAuiState((s) => s.composer.isEmpty);
  const lastMsgStatus = useAuiState((s) => {
    const msgs = s.thread.messages;
    const last = msgs[msgs.length - 1];
    if (!last) return null;
    const status = (last as { status?: { type: string } }).status?.type ?? "none";
    return `${last.role}:${status}`;
  });

  // Diagnostic: log whenever send-ability changes
  useEffect(() => {
    const canSend = !threadIsRunning && !composerIsEmpty;
    console.info(
      `[agent-diag] [${sessionId}] composer-state`,
      { threadIsRunning, composerIsEmpty, canSend, connected, lastMsgStatus },
    );
  }, [threadIsRunning, composerIsEmpty, connected, sessionId, lastMsgStatus]);

  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <DraftPersistenceSync />
      <SlashCommandPopover commands={sessionCommands} textareaRef={textareaRef} />
      <FileTagPopover textareaRef={textareaRef} workingDir={workingDir} />
      <div
        data-slot="composer-shell"
        className="flex w-full flex-col rounded-(--composer-radius) border bg-background overflow-hidden"
      >
        {pendingPermissions.size > 0 && (
          <div>
            {Array.from(pendingPermissions.entries()).map(([toolCallId, entry], index) => (
              <PermissionCard
                key={toolCallId}
                toolCallId={toolCallId}
                toolName={entry.toolName}
                args={{}}
                options={entry.options}
                isFirst={index === 0}
              />
            ))}
          </div>
        )}
        <ConnectionStatusBanner connected={connected} hasSession={hasSession} />
        <div className="flex flex-col gap-2 p-(--composer-padding)">
          <ComposerPrimitive.Input
            ref={textareaRef}
            placeholder="Message..."
            className="aui-composer-input max-h-32 min-h-10 w-full resize-none bg-transparent px-1.75 py-1 text-sm outline-none placeholder:text-muted-foreground/80"
            rows={1}
            autoFocus={!hasTouch}
            aria-label="Message input"
          />
          <div className="aui-composer-action-wrapper relative flex items-center justify-between">
            <div className="flex items-center gap-1">
              <ComposerOptionsMenu />
              {workingDir !== undefined && (
                <>
                  <FolderPicker
                    value={workingDir}
                    onChange={onWorkingDirChange ?? undefined}
                    onChangedFilesClick={hasActiveSession ? () => setFilesPopoverOpen(true) : undefined}
                  />
                  {sessionId && (
                    <ChangedFilesPopover
                      sessionId={sessionId}
                      refreshKey={resultCount}
                      open={filesPopoverOpen}
                      onOpenChange={setFilesPopoverOpen}
                      hideTrigger
                    />
                  )}
                </>
              )}
            </div>
            <div className="flex items-center gap-1">
              <AuiIf condition={(s) => !s.thread.isRunning}>
                <ComposerPrimitive.Send asChild>
                  <TooltipIconButton
                    tooltip="Send message"
                    side="bottom"
                    type="button"
                    variant="default"
                    size="icon"
                    className="aui-composer-send size-8 rounded-full"
                    aria-label="Send message"
                  >
                    <ArrowUpIcon className="aui-composer-send-icon size-4" />
                  </TooltipIconButton>
                </ComposerPrimitive.Send>
              </AuiIf>
              <AuiIf condition={(s) => s.thread.isRunning}>
                <StopButton />
              </AuiIf>
            </div>
          </div>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};
