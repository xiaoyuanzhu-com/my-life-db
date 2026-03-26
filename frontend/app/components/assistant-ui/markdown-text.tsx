"use client";

import "streamdown/styles.css";

import { useMessagePartText } from "@assistant-ui/react";
import { Streamdown, type CustomRendererProps } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { memo, useState, type FC } from "react";
import { Maximize2 } from "lucide-react";
import { PreviewFullscreen } from "~/components/agent/preview-fullscreen";

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

const plugins = {
  code,
  mermaid,
  renderers: [{ language: "html", component: HtmlRenderer }],
};

const controls = {
  mermaid: false as const,
};

const MarkdownTextImpl = () => {
  const { text, status } = useMessagePartText();
  return (
    <Streamdown
      plugins={plugins}
      controls={controls}
      isAnimating={status.type === "running"}
    >
      {text}
    </Streamdown>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
