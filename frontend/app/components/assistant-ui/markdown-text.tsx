"use client";

import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-streamdown";
import { useIsCodeFenceIncomplete } from "streamdown";
import mermaidLib from "mermaid";
import { memo, useEffect, useId, useRef, useState, type FC } from "react";
import { Maximize2 } from "lucide-react";
import { PreviewFullscreen } from "~/components/agent/preview-fullscreen";
import { getHighlighter, LIGHT_THEME, DARK_THEME } from "~/lib/markdown/shiki";

const HtmlRenderer: FC<SyntaxHighlighterProps> = ({ code: htmlCode }) => {
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

const mermaidConfig = {
  startOnLoad: false,
  theme: "default" as const,
  securityLevel: "strict" as const,
  fontFamily: "monospace",
  fontSize: 18,
  flowchart: { nodeSpacing: 80, rankSpacing: 80, padding: 20 },
  sequence: { actorMargin: 80, messageMargin: 50 },
};

let mermaidInitialized = false;

const MermaidRenderer: FC<SyntaxHighlighterProps> = ({ code: chart }) => {
  const isIncomplete = useIsCodeFenceIncomplete();
  const [svg, setSvg] = useState<string | null>(null);
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
      }
    }).catch(() => {});
  }, [chart, isIncomplete, id]);

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

const CodeRenderer: FC<SyntaxHighlighterProps> = ({ code, language }) => {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
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

  const trimmedCode = code.endsWith("\n") ? code.slice(0, -1) : code;

  return (
    <div className="relative my-3 rounded-lg border border-border/40 bg-zinc-50 dark:bg-zinc-900 overflow-hidden text-sm">
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
    </div>
  );
};

const MarkdownTextImpl = () => {
  return (
    <StreamdownTextPrimitive
      components={{ SyntaxHighlighter: CodeRenderer }}
      componentsByLanguage={{
        html: { SyntaxHighlighter: HtmlRenderer },
        mermaid: { SyntaxHighlighter: MermaidRenderer },
      }}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
