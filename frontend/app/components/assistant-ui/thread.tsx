import { TooltipIconButton } from "~/components/assistant-ui/tooltip-icon-button";
import { Button } from "~/components/ui/button";
import {
  AuiIf,
  ComposerPrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useRef, type FC } from "react";
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
import { PermissionModeSelector, type PermissionMode } from "~/components/agent/permission-mode-selector";
import { AgentTypeSelector, type AgentType } from "~/components/agent/agent-type-selector";
import { SlashCommandPopover } from "~/components/agent/slash-command-popover";
import { FileTagPopover } from "~/components/agent/file-tag-popover";
import { useAgentContext } from "~/components/agent/agent-context";

// Create the AssistantMessage with our ACP tool renderers baked in
const AcpAssistantMessage = createAssistantMessage(acpToolsConfig);

export const Thread: FC = () => {
  const { connected, planEntries, pendingPermissions, hasActiveSession, historyLoadError, sessionError } = useAgentContext();
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
      <ConnectionStatusBanner connected={connected} hasSession={hasSession} />
      <ThreadPrimitive.Viewport
        turnAnchor="top"
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

        <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col overflow-visible pb-4 md:pb-6">
          <ThreadScrollToBottom />
          <PlanView entries={planEntries} className="mb-2" />
          {pendingPermissions.size > 0 && (
            <div className="px-4 mb-2 space-y-2">
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
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
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
 * Uses ResizeObserver to react to actual content changes (not timers).
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

    const observer = new ResizeObserver(() => {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' });
      // Auto-disconnect after content stops changing
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => observer.disconnect(), 500);
    });

    observer.observe(viewport);

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

const Composer: FC = () => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasTouch = useHasTouch();
  const {
    workingDir, onWorkingDirChange,
    permissionMode, onPermissionModeChange,
    agentType, onAgentTypeChange,
    sessionCommands,
    hasActiveSession,
  } = useAgentContext();

  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <SlashCommandPopover commands={sessionCommands} textareaRef={textareaRef} />
      <FileTagPopover textareaRef={textareaRef} />
      <div
        data-slot="composer-shell"
        className="flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-background p-(--composer-padding) transition-shadow focus-within:border-ring/75 focus-within:ring-2 focus-within:ring-ring/20"
      >
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
            {workingDir !== undefined && onWorkingDirChange && (
              <FolderPicker value={workingDir} onChange={onWorkingDirChange} />
            )}
            {agentType !== undefined && (
              <AgentTypeSelector
                value={agentType as AgentType}
                onChange={(t) => onAgentTypeChange?.(t)}
                disabled={!onAgentTypeChange || hasActiveSession}
              />
            )}
            {permissionMode !== undefined && onPermissionModeChange && (
              <PermissionModeSelector value={permissionMode as PermissionMode} onChange={(m) => onPermissionModeChange(m)} />
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
              <ComposerPrimitive.Cancel asChild>
                <Button
                  type="button"
                  variant="default"
                  size="icon"
                  className="aui-composer-cancel size-8 rounded-full"
                  aria-label="Stop generating"
                >
                  <SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
                </Button>
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </div>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};
