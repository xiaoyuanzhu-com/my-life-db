import { useTranslation } from "react-i18next";
import { TooltipIconButton } from "~/components/assistant-ui/tooltip-icon-button";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Switch } from "~/components/ui/switch";
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
  AtSign,
  Plus,
  SquareIcon,
  SquareSlash,
} from "lucide-react";
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";
import TextareaAutosize, { type TextareaAutosizeProps } from "react-textarea-autosize";
import { useMessageInputKeyboard } from "~/hooks/use-message-input-keyboard";
import { useNavigate } from "react-router";
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
import { useFeatureFlags } from "~/contexts/feature-flags-context";
import { AttachmentStrip } from "~/components/agent/attachment-strip";
import { useAgentAttachments } from "~/hooks/use-agent-attachments";
import { Paperclip } from "lucide-react";
import {
  useSkills,
  useMCPServers,
  useToggleMCPServer,
  useMCPServerTools,
  type MCPServerEntry,
} from "~/hooks/use-agent-extras";

// Create the AssistantMessage with our ACP tool renderers baked in
const AcpAssistantMessage = createAssistantMessage(acpToolsConfig);

type ThreadProps = {
  onAttachmentsStorageIdChange?: (storageId: string | null) => void
  /** When rendering for an existing session, the session's persisted
   *  storageId so subsequent uploads stay in the same folder. */
  existingStorageId?: string | null
}

export const Thread: FC<ThreadProps> = ({ onAttachmentsStorageIdChange, existingStorageId }) => {
  const { pendingPermissions, hasActiveSession, historyLoadError, sessionError } = useAgentContext();
  const { hybridTopInset } = useFeatureFlags();
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
        ["--thread-max-width" as string]: "64rem",
        ["--composer-radius" as string]: "12px",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        autoScroll
        className="aui-thread-viewport relative flex flex-1 flex-col overflow-x-hidden overflow-y-scroll scroll-smooth pt-4"
        // When rendered inside the iOS hybrid shell, the SwiftUI navigation
        // bar (44pt inline) overlays the WebView (which uses .ignoresSafeArea).
        // Push the message list down past the status bar (`--native-sat`) +
        // the nav bar height, preserving the original 1rem breathing room.
        style={
          hybridTopInset
            ? {
                paddingTop:
                  "calc(var(--native-sat, env(safe-area-inset-top, 0px)) + 44px + 1rem)",
              }
            : undefined
        }
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

        <div className="mx-auto w-full max-w-(--thread-max-width) px-4 md:px-18">
          <ThreadPrimitive.Messages>
            {() => <ThreadMessage />}
          </ThreadPrimitive.Messages>
        </div>

        {isRunning && pendingPermissions.size === 0 && (
          <div className="mx-auto w-full max-w-(--thread-max-width) px-4 md:px-18">
            <AgentWIP />
          </div>
        )}

        <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto flex w-full max-w-(--thread-max-width) flex-col overflow-visible px-2 md:px-16">
          <ThreadScrollToBottom />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 md:px-16 pb-4 md:pb-6">
        <Composer onAttachmentsStorageIdChange={onAttachmentsStorageIdChange} existingStorageId={existingStorageId} />
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
  const { t } = useTranslation('common');
  return (
    <div className="mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center">
      <p className="text-muted-foreground text-sm">{t('states.loading')}</p>
    </div>
  );
};

const ThreadHistoryError: FC<{ message: string }> = ({ message }) => {
  const { t } = useTranslation('agent');
  return (
    <div className="mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center gap-2">
      <p className="text-muted-foreground text-sm">{t('thread.sessionHistoryUnavailable')}</p>
      <p className="text-muted-foreground/60 text-xs max-w-sm text-center">{message}</p>
      <p className="text-muted-foreground/60 text-xs">You can still send a new message to continue this session.</p>
    </div>
  );
};

const ThreadSessionError: FC<{ message: string }> = ({ message }) => {
  const { t } = useTranslation('agent');
  return (
    <div className="mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center gap-2">
      <p className="text-muted-foreground text-sm">{t('thread.sessionFailed')}</p>
      <p className="text-muted-foreground/60 text-xs max-w-sm text-center break-words">{message}</p>
      <p className="text-muted-foreground/60 text-xs">You can start a new session or retry with a new message.</p>
    </div>
  );
};

const ThreadWelcome: FC = () => {
  const { t } = useTranslation('agent');
  return (
    <div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center">
      <p className="text-muted-foreground text-sm">{t('thread.startConversation')}</p>
    </div>
  );
};

/** Stop button that directly calls cancelRun on the thread runtime.
 * ComposerPrimitive.Cancel gates on canCancel which can be unreliable
 * with external store runtimes, so we bypass it entirely. */
const StopButton: FC = () => {
  const { t } = useTranslation('agent');
  const aui = useAui();
  return (
    <Button
      type="button"
      variant="default"
      size="icon"
      className="aui-composer-cancel size-8 rounded-full"
      aria-label={t('thread.stopGenerating')}
      onClick={() => aui.thread().cancelRun()}
    >
      <SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
    </Button>
  );
};

/**
 * SendButton — composer send button used in place of ComposerPrimitive.Send
 * so that we can intercept clicks to append staged attachment @-paths before
 * calling composerRuntime.send(). Also disables/re-enables based on the
 * normal "empty composer" rule and the "uploads still pending" gate.
 */
const SendButton: FC<{
  disabled: boolean;
  hasAttachments: boolean;
  tooltip: string;
  onSend: () => void;
}> = ({ disabled, hasAttachments, tooltip, onSend }) => {
  const composerIsEmpty = useAuiState((s) => s.composer.isEmpty);
  const canSend = (!composerIsEmpty || hasAttachments) && !disabled;
  return (
    <TooltipIconButton
      tooltip={tooltip}
      side="bottom"
      type="button"
      variant="default"
      size="icon"
      className="aui-composer-send size-8 rounded-full"
      aria-label={tooltip}
      disabled={!canSend}
      onClick={onSend}
    >
      <ArrowUpIcon className="aui-composer-send-icon size-4" />
    </TooltipIconButton>
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

/**
 * PlainComposerInput — uncontrolled textarea backed by composer runtime.
 *
 * Replacement for `ComposerPrimitive.Input`.
 *
 * IMPORTANT: this textarea is INTENTIONALLY UNCONTROLLED (no `value` prop —
 * just `defaultValue` for initial render). We discovered the controlled form
 * fights the IME during rapid-fire deletes:
 *
 *   - User types → composer.text updates → React's value prop = N+1.
 *   - IME fires fake `deleteContentBackward` → DOM goes N+1 → N.
 *   - Our onChange calls `composer.setText(N)` (state update is scheduled).
 *   - **Between commits**, React's controlled-input value-tracker compares
 *     DOM to its STALE prop (still N+1) and restores DOM back to N+1.
 *   - The IME's next event sees DOM=N+1, fires another delete → N. Loop.
 *   - After ~10 unsuccessful deletes the IME gives up and just inserts the
 *     polished text at the cursor → **duplication**.
 *
 * In a vanilla (uncontrolled) textarea, the same IME flow works correctly
 * because there's no value-prop tracker to fight. So we mirror that here:
 * the OS / IME fully owns the textarea value during typing; we sync changes
 * back to composer state via `onChange`. External writes (draft restore,
 * send-clear, /clear command) are applied to `textarea.value` imperatively
 * via a `useEffect`, which won't interfere with the OS / IME's edit cycles.
 *
 * Other features we drop intentionally vs. ComposerPrimitive.Input:
 *   - mention popover keyboard routing (we use our own popovers)
 *   - addAttachmentOnPaste (we accept files via drag-drop / picker only)
 *   - composer.cancel on Escape (no edit-then-cancel flow here)
 *   - focus-on-runStart / focus-on-scroll-to-bottom / focus-on-threadSwitched
 *     (minor UX; can be re-added with small effects if anyone misses them)
 */
type PlainComposerInputProps = Omit<
  TextareaAutosizeProps,
  "value" | "defaultValue" | "disabled"
> & {
  /** Optional onChange runs BEFORE composer.setText (useful for diagnostics). */
  onChange?: React.ChangeEventHandler<HTMLTextAreaElement>
}

const PlainComposerInput = forwardRef<HTMLTextAreaElement, PlainComposerInputProps>(
  function PlainComposerInput({ onChange, onKeyDown, onCompositionStart, onCompositionEnd, ...rest }, forwardedRef) {
    const composerRuntime = useComposerRuntime();
    const text = useAuiState((s) => (s.composer.isEditing ? s.composer.text : ""));
    const isDisabled = useAuiState((s) => s.thread.isDisabled ?? false);
    const keyboard = useMessageInputKeyboard();

    // Hold an internal ref for imperative sync; still forward to the caller.
    const internalRef = useRef<HTMLTextAreaElement | null>(null);
    const setRef = useCallback(
      (el: HTMLTextAreaElement | null) => {
        internalRef.current = el;
        if (typeof forwardedRef === "function") {
          forwardedRef(el);
        } else if (forwardedRef) {
          forwardedRef.current = el;
        }
      },
      [forwardedRef],
    );

    // Capture the initial composer text so we can use it as `defaultValue`
    // without re-applying it on every render. After mount, composer-state
    // changes are routed through the useEffect below — never via React props.
    const initialTextRef = useRef(text);

    // Sync external composer.text changes (draft restore, send-clear, etc.)
    // to the textarea imperatively. The typing path is a no-op here because
    // by the time this effect runs, our onChange has already pushed the
    // user's input into composer.text — so `text === ta.value` and we skip.
    useEffect(() => {
      const ta = internalRef.current;
      if (!ta) return;
      if (ta.value === text) return;
      // External change: overwrite. Cursor goes to end of new text.
      ta.value = text;
    }, [text]);

    return (
      <TextareaAutosize
        {...rest}
        ref={setRef}
        defaultValue={initialTextRef.current}
        disabled={isDisabled}
        enterKeyHint={keyboard.enterKeyHint}
        onChange={(e) => {
          // Caller's onChange (if any) runs first, then we sync to composer
          // state. Direct call — no flushResourcesSync, no value prop, no
          // React-controlled-input restoration.
          onChange?.(e);
          composerRuntime.setText(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (keyboard.shouldSend(e)) {
            e.preventDefault();
            e.currentTarget.closest("form")?.requestSubmit();
          }
        }}
        onCompositionStart={(e) => {
          onCompositionStart?.(e);
          keyboard.onCompositionStart();
        }}
        onCompositionEnd={(e) => {
          onCompositionEnd?.(e);
          keyboard.onCompositionEnd();
        }}
      />
    );
  },
);

const MCPServerRow: FC<{
  server: MCPServerEntry
  onToggleDisabled: (disabled: boolean) => void
}> = ({ server, onToggleDisabled }) => {
  const { t } = useTranslation('agent');
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useMCPServerTools(server.name, { enabled: open })
  const tools = data?.tools ?? []

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger className="px-2 py-1.5 gap-2">
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-xs text-foreground truncate">{server.name}</span>
          {(server.url || server.command) && (
            <span className="text-[10px] text-muted-foreground/70 truncate">
              {server.url ?? server.command}
            </span>
          )}
        </div>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-64 max-w-96 max-h-96 overflow-y-auto">
        <div className="flex items-center justify-between px-2 py-1.5 gap-3">
          <span className="text-xs text-foreground">{t('thread.enabled')}</span>
          <Switch
            size="sm"
            checked={!server.disabled}
            onCheckedChange={(checked) => onToggleDisabled(!checked)}
          />
        </div>
        <DropdownMenuSeparator className="mx-2" />
        <div className="px-2 py-1.5">
          {isLoading && (
            <div className="text-[11px] text-muted-foreground/70">Loading tools…</div>
          )}
          {!isLoading && data?.error && (
            <div className="text-[11px] text-destructive/80 break-words">{data.error}</div>
          )}
          {!isLoading && !data?.error && tools.length === 0 && (
            <div className="text-[11px] text-muted-foreground/70">No tools advertised.</div>
          )}
          {!isLoading && !data?.error && tools.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {tools.map((t) => (
                <div key={t.name} className="flex flex-col gap-0.5">
                  <span className="text-[11px] font-mono text-foreground/80 break-all">
                    {t.name}
                  </span>
                  {t.description && (
                    <span className="text-[10px] text-muted-foreground/70 line-clamp-2">
                      {t.description}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

const MCPServersSubMenu: FC = () => {
  const { t } = useTranslation('agent');
  const { data: servers } = useMCPServers()
  const toggle = useToggleMCPServer()
  const navigate = useNavigate()
  const list = servers ?? []

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="px-2 py-1.5 text-xs text-muted-foreground focus:text-foreground">
        <span className="shrink-0">{t('thread.mcp')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-56 max-w-80 max-h-96 overflow-y-auto">
        {list.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No MCP servers configured.
          </div>
        )}
        {list.map((s) => (
          <MCPServerRow
            key={s.name}
            server={s}
            onToggleDisabled={(disabled) => toggle.mutate({ name: s.name, disabled })}
          />
        ))}
        {list.length > 0 && <DropdownMenuSeparator className="mx-2" />}
        <DropdownMenuItem
          onSelect={() =>
            navigate(`/agent?seed=${encodeURIComponent('please help install a new MCP server')}`)
          }
          className="px-2 py-1.5 gap-2 text-xs text-muted-foreground focus:text-foreground"
        >
          <Plus className="size-3.5 shrink-0" />
          <span>{t('thread.addNewMcp')}</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

const SkillsSubMenu: FC<{ onSelectSkill: (name: string) => void }> = ({ onSelectSkill }) => {
  const { t } = useTranslation('agent');
  // Reading workingDir here (rather than prop-drilling) so the skills list
  // updates when the composer's cwd changes, picking up project-level skills
  // under .claude/skills, .agents/skills, .gemini/skills in that dir.
  const { workingDir } = useAgentContext()
  const { data: skills } = useSkills(workingDir)
  const navigate = useNavigate()
  const list = skills ?? []
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="px-2 py-1.5 text-xs text-muted-foreground focus:text-foreground">
        <span className="shrink-0">{t('thread.skills')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-64 max-w-96 max-h-80 overflow-y-auto">
        {list.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No skills installed.
          </div>
        )}
        {list.map((s) => (
          <DropdownMenuItem
            key={s.path}
            onSelect={() => onSelectSkill(s.name)}
            className="flex flex-col items-stretch px-2 py-1.5 gap-0.5 text-muted-foreground focus:text-foreground"
          >
            <div className="flex items-center justify-between gap-2 w-full">
              <span className="text-xs text-foreground truncate">{s.name}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 shrink-0">
                {s.source}
              </span>
            </div>
            {s.description && (
              <span className="text-[11px] text-muted-foreground line-clamp-2">
                {s.description}
              </span>
            )}
          </DropdownMenuItem>
        ))}
        {list.length > 0 && <DropdownMenuSeparator className="mx-2" />}
        <DropdownMenuItem
          onSelect={() =>
            navigate(`/agent?seed=${encodeURIComponent('please help install a new skill')}`)
          }
          className="px-2 py-1.5 gap-2 text-xs text-muted-foreground focus:text-foreground"
        >
          <Plus className="size-3.5 shrink-0" />
          <span>{t('thread.addNewSkill')}</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

const ComposerOptionsMenu: FC<{
  onAttachFiles: () => void
  onAddContext: () => void
  onShowCommands: () => void
  onUseSkill: (name: string) => void
}> = ({ onAttachFiles, onAddContext, onShowCommands, onUseSkill }) => {
  const { t } = useTranslation('agent');
  const {
    agentType, onAgentTypeChange,
    configOptions, onConfigOptionChange,
    sessionId,
  } = useAgentContext()
  const hasActiveSession = !!sessionId

  const sortedOptions = useMemo(() => {
    // Stable render order: model → mode → everything else (by category)
    const order: Record<string, number> = { model: 0, mode: 1 }
    if (!configOptions) return []
    return [...configOptions].sort((a, b) =>
      (order[a.category] ?? 2) - (order[b.category] ?? 2)
    )
  }, [configOptions])

  const hasSelectors = agentType !== undefined || sortedOptions.length > 0

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center px-1.5 sm:px-2 py-1 sm:py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/10 cursor-pointer transition-colors shrink-0"
          title={t('thread.options')}
        >
          <Plus className="h-3 w-3 sm:h-3.5 sm:w-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={4}>
        {agentType !== undefined && (
          <div className="flex items-center justify-between px-2 py-1.5 gap-4">
            <span className="text-xs text-muted-foreground shrink-0">{t('thread.agent')}</span>
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
        {hasSelectors && <DropdownMenuSeparator className="mx-2" />}
        <MCPServersSubMenu />
        <SkillsSubMenu onSelectSkill={onUseSkill} />
        <DropdownMenuSeparator className="mx-2" />
        <DropdownMenuItem
          onSelect={onAttachFiles}
          className="px-2 py-1.5 gap-2 text-xs text-muted-foreground focus:text-foreground"
        >
          <Paperclip className="size-3.5 shrink-0" />
          <span>{t('thread.uploadFiles')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onAddContext}
          className="px-2 py-1.5 gap-2 text-xs text-muted-foreground focus:text-foreground"
        >
          <AtSign className="size-3.5 shrink-0" />
          <span>{t('thread.addContext')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onShowCommands}
          className="px-2 py-1.5 gap-2 text-xs text-muted-foreground focus:text-foreground"
        >
          <SquareSlash className="size-3.5 shrink-0" />
          <span>{t('thread.slashCommands')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type ComposerProps = {
  onAttachmentsStorageIdChange?: (storageId: string | null) => void
  existingStorageId?: string | null
}
const Composer: FC<ComposerProps> = ({ onAttachmentsStorageIdChange, existingStorageId }) => {
  const { t } = useTranslation('agent');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasTouch = useHasTouch();
  const [filesPopoverOpen, setFilesPopoverOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
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
  const composerRuntime = useComposerRuntime();
  const aui = useAui();
  const attachments = useAgentAttachments({ initialStorageId: existingStorageId ?? null });

  useEffect(() => {
    onAttachmentsStorageIdChange?.(attachments.storageId)
  }, [attachments.storageId, onAttachmentsStorageIdChange])

  const handleFilesPicked = (files: FileList | File[] | null) => {
    if (!files) return;
    const arr = Array.from(files);
    if (arr.length === 0) return;
    attachments.addFiles(arr);
  };

  const handleAddContext = () => {
    const current = composerRuntime.getState().text ?? "";
    const needsSpace = current.length > 0 && !/\s$/.test(current);
    composerRuntime.setText(current + (needsSpace ? " @" : "@"));
    // Defer focus so it lands after the dropdown finishes closing.
    setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 0);
  };

  const handleUseSkill = (name: string) => {
    const current = composerRuntime.getState().text ?? "";
    const needsSpace = current.length > 0 && !/\s$/.test(current);
    const snippet = `use the ${name} skill to `;
    composerRuntime.setText(current + (needsSpace ? " " : "") + snippet);
    setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 0);
  };

  const handleShowCommands = () => {
    // Slash popover only triggers when the whole composer starts with "/" and
    // has no spaces, so replace existing text instead of appending.
    composerRuntime.setText("/");
    setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 0);
  };

  const handleSend = () => {
    if (attachments.hasPending) return;
    const ready = attachments.readyAttachments;
    if (ready.length === 0) {
      composerRuntime.send();
      return;
    }
    // Route attachment refs through thread.append so the @-paths are
    // guaranteed to be in the outgoing message — the setText+send pattern
    // dropped them in practice.
    const current = composerRuntime.getState().text ?? "";
    const refs = ready.map((a) => `@${a.absolutePath}`).join(" ");
    const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n\n";
    const fullText = current + sep + refs;
    aui.thread().append({
      role: "user",
      content: [{ type: "text", text: fullText }],
    });
    composerRuntime.reset();
    attachments.clear();
  };

  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative flex w-full flex-col"
      onSubmit={(e) => {
        // Intercept Enter-key form submit so it goes through handleSend
        // (which appends @-paths for staged attachments). preventDefault
        // also disables ComposerPrimitive.Root's built-in composer.send.
        e.preventDefault();
        handleSend();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setIsDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the root container, not child elements
        if (e.currentTarget === e.target) setIsDragOver(false);
      }}
      onDrop={(e) => {
        if (e.dataTransfer?.files?.length) {
          e.preventDefault();
          setIsDragOver(false);
          handleFilesPicked(e.dataTransfer.files);
        }
      }}
    >
      <DraftPersistenceSync />
      <SlashCommandPopover commands={sessionCommands} textareaRef={textareaRef} />
      <FileTagPopover textareaRef={textareaRef} workingDir={workingDir} />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(e) => {
          handleFilesPicked(e.target.files);
          // Reset so selecting the same file again still fires onChange
          e.target.value = "";
        }}
      />
      <div
        data-slot="composer-shell"
        className={
          "flex w-full flex-col rounded-(--composer-radius) border bg-background overflow-hidden " +
          (isDragOver ? "ring-2 ring-primary/60" : "")
        }
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
        <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />
        <div className="flex flex-col gap-2 p-(--composer-padding)">
          <PlainComposerInput
            ref={textareaRef}
            placeholder={t('thread.messagePlaceholder')}
            className="aui-composer-input max-h-32 min-h-10 w-full resize-none bg-transparent px-1.75 py-1 text-sm outline-none placeholder:text-muted-foreground/80"
            rows={1}
            autoFocus={!hasTouch}
            aria-label={t('thread.messageInput')}
          />
          <div className="aui-composer-action-wrapper relative flex items-center justify-between">
            <div className="flex items-center gap-1">
              <ComposerOptionsMenu
                onAttachFiles={() => fileInputRef.current?.click()}
                onAddContext={handleAddContext}
                onShowCommands={handleShowCommands}
                onUseSkill={handleUseSkill}
              />
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
                <SendButton
                  disabled={attachments.hasPending}
                  hasAttachments={attachments.readyAttachments.length > 0}
                  tooltip={
                    attachments.hasPending
                      ? "Waiting for uploads"
                      : t('thread.sendMessage')
                  }
                  onSend={handleSend}
                />
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
