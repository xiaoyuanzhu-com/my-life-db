"use client";

import "streamdown/styles.css";

import { useMessagePartText } from "@assistant-ui/react";
import { Streamdown, type CustomRendererProps } from "streamdown";
import { mermaid as mermaidPlugin } from "@streamdown/mermaid";
import mermaidLib from "mermaid";
import { memo, useEffect, useId, useRef, useState, type FC } from "react";
import { Maximize2 } from "lucide-react";
import { PreviewFullscreen } from "~/components/agent/preview-fullscreen";
import { ShikiCodeBlock } from "./shiki-code-block";

const HtmlRenderer: FC<CustomRendererProps> = ({ code: htmlCode }) => {
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

const MermaidRenderer: FC<CustomRendererProps> = ({ code: chart, isIncomplete }) => {
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

const plugins = {
  mermaid: mermaidPlugin,
  renderers: [
    { language: "html", component: HtmlRenderer },
    { language: "mermaid", component: MermaidRenderer },
  ],
};

const components = {
  pre: ShikiCodeBlock,
};

const MarkdownTextImpl = () => {
  const { text, status } = useMessagePartText();
  return (
    <Streamdown
      plugins={plugins}
      components={components}
      isAnimating={status.type === "running"}
    >
      {text}
    </Streamdown>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
