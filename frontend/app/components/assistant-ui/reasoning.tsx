"use client";

import { memo } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  useAuiState,
  type ReasoningMessagePartComponent,
  type ReasoningGroupComponent,
} from "@assistant-ui/react";
import { MarkdownText } from "~/components/assistant-ui/markdown-text";

const ReasoningImpl: ReasoningMessagePartComponent = () => <MarkdownText />;

const ReasoningGroupImpl: ReasoningGroupComponent = ({
  children,
  startIndex,
  endIndex,
}) => {
  const isStreaming = useAuiState((s) => {
    if (s.message.status?.type !== "running") return false;
    const lastIndex = s.message.parts.length - 1;
    if (lastIndex < 0) return false;
    const lastType = s.message.parts[lastIndex]?.type;
    if (lastType !== "reasoning") return false;
    return lastIndex >= startIndex && lastIndex <= endIndex;
  });

  return (
    <details className="mb-2 group">
      <summary className="flex items-start gap-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-muted-foreground hover:text-foreground">
        <span className="font-mono text-[8px] h-5 flex items-center shrink-0">
          <ChevronRightIcon className="size-3 transition-transform group-open:rotate-90" />
        </span>
        <span className="h-5 flex items-center text-sm">
          Thinking{isStreaming ? "..." : ""}
        </span>
      </summary>
      <div className="flex gap-2">
        <span className="font-mono text-[8px] shrink-0 invisible" aria-hidden="true">&#x25CF;</span>
        <div className="text-sm text-muted-foreground max-h-64 overflow-y-auto">
          {children}
        </div>
      </div>
    </details>
  );
};

const Reasoning = memo(ReasoningImpl) as unknown as ReasoningMessagePartComponent;
Reasoning.displayName = "Reasoning";

const ReasoningGroup = memo(ReasoningGroupImpl);
ReasoningGroup.displayName = "ReasoningGroup";

export { Reasoning, ReasoningGroup };
