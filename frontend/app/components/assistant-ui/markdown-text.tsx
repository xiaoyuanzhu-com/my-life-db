"use client";

import "streamdown/styles.css";

import {
  StreamdownTextPrimitive,
  type SyntaxHighlighterProps,
} from "@assistant-ui/react-streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { memo, useState, type FC } from "react";
import { Maximize2 } from "lucide-react";
import { PreviewFullscreen } from "~/components/agent/preview-fullscreen";

const plugins = { code, mermaid };

const HtmlSyntaxHighlighter: FC<SyntaxHighlighterProps> = ({
  code: htmlCode,
}) => {
  const [fullscreen, setFullscreen] = useState(false);
  return (
    <>
      <div className="relative my-2 rounded-lg border border-border/50 overflow-hidden">
        <iframe
          srcDoc={htmlCode}
          sandbox="allow-scripts"
          className="w-full bg-white"
          style={{ height: "60vh", border: "none" }}
        />
        <button
          type="button"
          className="preview-expand-btn"
          aria-label="Expand preview"
          title="Expand preview"
          onClick={() => setFullscreen(true)}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {fullscreen && (
        <PreviewFullscreen
          html={htmlCode}
          onClose={() => setFullscreen(false)}
        />
      )}
    </>
  );
};

const componentsByLanguage = {
  html: { SyntaxHighlighter: HtmlSyntaxHighlighter },
};

const MarkdownTextImpl = () => {
  return (
    <StreamdownTextPrimitive
      plugins={plugins}
      componentsByLanguage={componentsByLanguage}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  // HTML blocks: render as sandboxed iframe preview instead of code header + block.
  // The sibling <pre> is hidden via the [data-html-preview]+pre CSS selector.
  if (language === "html" && code) {
    // IMPORTANT: Do NOT entity-encode here. React's srcDoc prop sets the DOM
    // property directly — no HTML attribute decoding step. If we encoded
    // " → &quot;, the iframe's HTML parser would see class=&quot;foo&quot;
    // in "unquoted attribute value" mode, where the decoded " becomes a
    // literal character in the value instead of an attribute delimiter.
    //
    // Compare with html-preview.ts (innerHTML path) which DOES need encoding
    // because innerHTML goes through an HTML attribute parse that decodes
    // one layer of entities before setting the DOM property.
    return (
      <div data-html-preview className="my-2 rounded-lg border border-border/50 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 bg-muted/50 text-xs">
          <span className="font-medium text-muted-foreground">html preview</span>
          <TooltipIconButton tooltip="Copy" onClick={onCopy}>
            {!isCopied && <CopyIcon />}
            {isCopied && <CheckIcon />}
          </TooltipIconButton>
        </div>
        <iframe
          srcDoc={code}
          sandbox="allow-scripts"
          className="w-full bg-white"
          style={{ height: "60vh", border: "none" }}
        />
      </div>
    );
  }

  return (
    <div className="aui-code-header-root mt-2.5 flex items-center justify-between rounded-t-lg border border-border/50 border-b-0 bg-muted/50 px-3 py-1.5 text-xs">
      <span className="aui-code-header-language font-medium text-muted-foreground lowercase">
        {language}
      </span>
      <TooltipIconButton tooltip="Copy" onClick={onCopy}>
        {!isCopied && <CopyIcon />}
        {isCopied && <CheckIcon />}
      </TooltipIconButton>
    </div>
  );
};

const useCopyToClipboard = ({
  copiedDuration = 3000,
}: {
  copiedDuration?: number;
} = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    if (!value) return;

    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };

  return { isCopied, copyToClipboard };
};

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "aui-md-h1 mb-2 scroll-m-20 font-semibold text-base first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "aui-md-h2 mt-3 mb-1.5 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "aui-md-h3 mt-2.5 mb-1 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        "aui-md-h4 mt-2 mb-1 scroll-m-20 font-medium text-sm first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      className={cn(
        "aui-md-h5 mt-2 mb-1 font-medium text-sm first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn(
        "aui-md-h6 mt-2 mb-1 font-medium text-sm first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn(
        "aui-md-p my-2.5 leading-normal first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        "aui-md-a text-primary underline underline-offset-2 hover:text-primary/80",
        className,
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "aui-md-blockquote my-2.5 border-muted-foreground/30 border-l-2 pl-3 text-muted-foreground italic",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "aui-md-ul my-2 ml-4 list-disc marker:text-muted-foreground [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "aui-md-ol my-2 ml-4 list-decimal marker:text-muted-foreground [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr
      className={cn("aui-md-hr my-2 border-muted-foreground/20", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }) => (
    <table
      className={cn(
        "aui-md-table my-2 w-full border-separate border-spacing-0 overflow-y-auto",
        className,
      )}
      {...props}
    />
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th bg-muted px-2 py-1 text-left font-medium first:rounded-tl-lg last:rounded-tr-lg [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td border-muted-foreground/20 border-b border-l px-2 py-1 text-left last:border-r [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-bl-lg [&:last-child>td:last-child]:rounded-br-lg",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("aui-md-li leading-normal", className)} {...props} />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "aui-md-pre overflow-x-auto rounded-t-none rounded-b-lg border border-border/50 border-t-0 bg-muted/30 p-3 text-xs leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "aui-md-inline-code rounded-md border border-border/50 bg-muted/50 px-1.5 py-0.5 font-mono text-[0.85em]",
          className,
        )}
        {...props}
      />
    );
  },
  CodeHeader,
});
