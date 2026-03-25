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
