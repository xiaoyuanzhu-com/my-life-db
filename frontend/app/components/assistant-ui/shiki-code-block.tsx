"use client";

import {
  memo,
  useEffect,
  useState,
  useRef,
  type ReactElement,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { getHighlighter, LIGHT_THEME, DARK_THEME } from "~/lib/markdown/shiki";

interface CodeProps {
  className?: string;
  children?: ReactNode;
}

function isReactElement(node: unknown): node is ReactElement<CodeProps> {
  return (
    node !== null &&
    typeof node === "object" &&
    "props" in (node as object) &&
    "type" in (node as object)
  );
}

function extractCodeInfo(children: ReactNode): {
  language: string;
  code: string;
} {
  // react-markdown wraps fenced code in <pre><code className="language-xxx">
  if (isReactElement(children)) {
    const className = children.props?.className || "";
    const langMatch = className.match(/language-(\S+)/);
    const language = langMatch?.[1] || "";
    const code = extractText(children.props?.children);
    return { language, code };
  }
  return { language: "", code: extractText(children) };
}

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isReactElement(node)) {
    return extractText(node.props?.children);
  }
  return "";
}

const ShikiCodeBlockImpl = (props: HTMLAttributes<HTMLPreElement>) => {
  const { children, ...rest } = props;
  const { language, code } = extractCodeInfo(children);
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

      // Load language if needed
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
          themes: {
            light: LIGHT_THEME,
            dark: DARK_THEME,
          },
          defaultColor: false,
        });
        if (!cancelled) setHighlightedHtml(html);
      } catch {
        // Fallback: will use plain text rendering
      }
    }

    highlight();
    return () => { cancelled = true; };
  }, [code, language]);

  const trimmedCode = code.endsWith("\n") ? code.slice(0, -1) : code;

  return (
    <div className="relative my-3 rounded-lg border border-border/40 bg-zinc-50 dark:bg-zinc-900 overflow-hidden text-sm">
      {/* Code body */}
      {highlightedHtml ? (
        <div
          className="shiki-code-block overflow-x-auto [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:px-3 [&_pre]:py-3 [&_code]:!text-[13px] [&_code]:!leading-relaxed"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre {...rest} className="!m-0 !bg-transparent px-3 py-3 overflow-x-auto">
          <code className="!text-[13px] !leading-relaxed">{trimmedCode}</code>
        </pre>
      )}
    </div>
  );
};

export const ShikiCodeBlock = memo(ShikiCodeBlockImpl);
