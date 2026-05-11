"use client";

import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-streamdown";
import { useIsCodeFenceIncomplete } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import mermaidLib from "mermaid";
import {
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Maximize2 } from "lucide-react";
import { PreviewFullscreen } from "~/components/agent/preview-fullscreen";
import { getHighlighter, LIGHT_THEME, DARK_THEME } from "~/lib/markdown/shiki";

type RendererProps = Pick<SyntaxHighlighterProps, "node" | "language" | "code">;

const HtmlRenderer: FC<RendererProps> = ({ code: htmlCode }) => {
  const [fullscreen, setFullscreen] = useState(false);
  return (
    <>
      <div className="relative my-2 rounded-lg border border-border/50 overflow-hidden">
        <iframe
          srcDoc={htmlCode}
          sandbox="allow-scripts allow-same-origin"
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

const mermaidConfig = {
  startOnLoad: false,
  theme: "default" as const,
  securityLevel: "strict" as const,
  fontFamily: "monospace",
  fontSize: 18,
  suppressErrorRendering: true,
  flowchart: { nodeSpacing: 80, rankSpacing: 80, padding: 20 },
  sequence: { actorMargin: 80, messageMargin: 50 },
};

let mermaidInitialized = false;

const MermaidRenderer: FC<RendererProps> = ({ code: chart }) => {
  const isIncomplete = useIsCodeFenceIncomplete();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const id = useId();
  const renderIdRef = useRef(0);

  useEffect(() => {
    if (isIncomplete) return;

    if (!mermaidInitialized) {
      mermaidLib.initialize(mermaidConfig);
      mermaidInitialized = true;
    }

    const currentRender = ++renderIdRef.current;
    const renderId = `mermaid-${id.replace(/:/g, "")}-${Date.now()}`;

    mermaidLib.render(renderId, chart).then(({ svg: result }) => {
      if (currentRender === renderIdRef.current) {
        setSvg(result);
        setError(null);
      }
    }).catch((err: unknown) => {
      if (currentRender === renderIdRef.current) {
        setSvg(null);
        setError(err instanceof Error ? err.message : "Failed to render diagram");
      }
      // Mermaid appends temp <div id="d{renderId}"><svg id="{renderId}">
      // to document.body during render and cleans up only on success.
      document.getElementById(renderId)?.remove();
      document.getElementById(`d${renderId}`)?.remove();
    });
  }, [chart, isIncomplete, id]);

  if (error) {
    return (
      <div className="my-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 overflow-hidden">
        <pre className="overflow-x-auto text-xs"><code>{chart}</code></pre>
        <p className="mt-2 text-destructive text-sm">{error}</p>
      </div>
    );
  }

  if (!svg) return null;

  return (
    <>
      <div className="relative my-4 rounded-md border border-border bg-background overflow-hidden">
        <div
          className="flex justify-center p-4 [&_svg]:max-w-none"
          dangerouslySetInnerHTML={{ __html: svg }}
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
          html={`<div style="display:flex;justify-content:center;align-items:center;min-height:90vh">${svg}</div>`}
          onClose={() => setFullscreen(false)}
        />
      )}
    </>
  );
};

const CodeRenderer: FC<RendererProps> = ({ code, language }) => {
  const { t } = useTranslation('agent');
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef(code);
  const langRef = useRef(language);

  codeRef.current = code;
  langRef.current = language;

  useEffect(() => {
    let cancelled = false;

    async function highlight() {
      const hl = await getHighlighter();
      if (cancelled) return;

      const lang = langRef.current || "text";

      if (lang !== "text") {
        try {
          const loaded = hl.getLoadedLanguages();
          if (!loaded.includes(lang as never)) {
            await hl.loadLanguage(lang as Parameters<typeof hl.loadLanguage>[0]);
          }
        } catch {
          // Language not supported, fall through to text
        }
      }

      if (cancelled) return;

      try {
        const html = hl.codeToHtml(codeRef.current, {
          lang,
          themes: { light: LIGHT_THEME, dark: DARK_THEME },
          defaultColor: false,
        });
        if (!cancelled) setHighlightedHtml(html);
      } catch {
        // Fallback: plain text rendering below
      }
    }

    highlight();
    return () => { cancelled = true; };
  }, [code, language]);

  const handleCopy = useCallback(() => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code);
    } else {
      // Fallback for non-secure contexts (HTTP)
      const textarea = document.createElement("textarea");
      textarea.value = code;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [code]);

  const trimmedCode = code.endsWith("\n") ? code.slice(0, -1) : code;

  return (
    <div className="group/code relative my-3 rounded-lg border border-border/40 bg-zinc-50 dark:bg-zinc-900 overflow-hidden text-sm">
      {highlightedHtml ? (
        <div
          className="shiki-code-block overflow-x-auto [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:px-3 [&_pre]:py-3 [&_code]:!text-[13px] [&_code]:!leading-relaxed"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre className="!m-0 !bg-transparent px-3 py-3 overflow-x-auto">
          <code className="!text-[13px] !leading-relaxed">{trimmedCode}</code>
        </pre>
      )}
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity rounded-md p-1.5 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm hover:bg-muted text-muted-foreground hover:text-foreground"
        title={t('thread.copyCode')}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
};

const LANGUAGE_REGEX = /language-([^\s]+)/;

const mathPlugin = createMathPlugin({ singleDollarTextMath: true });

function extractCode(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (!isValidElement(children)) return "";
  const props = children.props as Record<string, unknown>;
  if (props && typeof props["children"] === "string")
    return props["children"] as string;
  return "";
}

/**
 * Custom code component that bypasses @assistant-ui/react-streamdown's
 * buggy createCodeAdapter (which calls memo() result as a function).
 * Instead we handle inline/block detection and language dispatch directly.
 */
const CustomCode: FC<{
  node?: SyntaxHighlighterProps["node"];
  className?: string;
  children?: ReactNode;
  "data-block"?: string;
}> = ({ node, className, children, "data-block": dataBlock, ...props }) => {
  if (!dataBlock) {
    return (
      <code
        className={`aui-streamdown-inline-code ${className ?? ""}`.trim()}
        {...props}
      >
        {children}
      </code>
    );
  }

  const match = className?.match(LANGUAGE_REGEX);
  const language = match?.[1] ?? "";
  const code = extractCode(children);

  if (language === "html") {
    return <HtmlRenderer node={node} language={language} code={code} />;
  }
  if (language === "mermaid") {
    return <MermaidRenderer node={node} language={language} code={code} />;
  }
  return <CodeRenderer node={node} language={language} code={code} />;
};

const MarkdownTextImpl = () => {
  return (
    <StreamdownTextPrimitive
      components={{ code: CustomCode }}
      plugins={{ math: mathPlugin }}
      controls={{ table: false }}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
