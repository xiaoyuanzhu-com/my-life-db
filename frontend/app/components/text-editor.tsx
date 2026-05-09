import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type CompositionEvent,
  type KeyboardEvent,
  type UIEvent,
} from 'react';
import { createHighlighterCoreSync, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

import githubLight from 'shiki/themes/github-light.mjs';
import githubDark from 'shiki/themes/github-dark.mjs';

import langMarkdown from 'shiki/langs/markdown.mjs';
import langJson from 'shiki/langs/json.mjs';
import langYaml from 'shiki/langs/yaml.mjs';
import langJavaScript from 'shiki/langs/javascript.mjs';
import langTypeScript from 'shiki/langs/typescript.mjs';
import langTsx from 'shiki/langs/tsx.mjs';
import langJsx from 'shiki/langs/jsx.mjs';
import langGo from 'shiki/langs/go.mjs';
import langSwift from 'shiki/langs/swift.mjs';
import langPython from 'shiki/langs/python.mjs';
import langBash from 'shiki/langs/bash.mjs';
import langHtml from 'shiki/langs/html.mjs';
import langCss from 'shiki/langs/css.mjs';
import langSql from 'shiki/langs/sql.mjs';

interface TextEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  filename?: string;
  readOnly?: boolean;
  className?: string;
  onSave?: () => void;
}

const SUPPORTED_LANGS = new Set<string>([
  'markdown',
  'json',
  'yaml',
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'go',
  'swift',
  'python',
  'bash',
  'html',
  'css',
  'sql',
]);

const EXT_MAP: Record<string, string> = {
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  cts: 'typescript',
  mts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  go: 'go',
  swift: 'swift',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  html: 'html',
  htm: 'html',
  css: 'css',
  sql: 'sql',
};

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MAP[ext] ?? 'plaintext';
}

const MAX_HIGHLIGHT_BYTES = 500_000;
const MAX_HIGHLIGHT_LINES = 10_000;

let highlighter: HighlighterCore | null = null;
function getHighlighter(): HighlighterCore {
  if (!highlighter) {
    highlighter = createHighlighterCoreSync({
      themes: [githubLight, githubDark],
      langs: [
        langMarkdown,
        langJson,
        langYaml,
        langJavaScript,
        langTypeScript,
        langTsx,
        langJsx,
        langGo,
        langSwift,
        langPython,
        langBash,
        langHtml,
        langCss,
        langSql,
      ],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighter;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const compute = () =>
      document.documentElement.classList.contains('dark') ||
      (!document.documentElement.classList.contains('light') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);

    setIsDark(compute());

    const observer = new MutationObserver(() => setIsDark(compute()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onMq = () => setIsDark(compute());
    mq.addEventListener('change', onMq);

    return () => {
      observer.disconnect();
      mq.removeEventListener('change', onMq);
    };
  }, []);

  return isDark;
}

const sharedTextStyle: CSSProperties = {
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  lineHeight: 1.5,
  letterSpacing: 0,
  tabSize: 2,
  padding: '12px',
  margin: 0,
  border: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'break-word',
};

export function TextEditor({
  value,
  onChange,
  language,
  filename,
  readOnly = false,
  className,
  onSave,
}: TextEditorProps) {
  const isDark = useIsDark();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLDivElement | null>(null);
  const [isComposing, setIsComposing] = useState(false);

  const detectedLanguage = filename && !language
    ? getLanguageFromFilename(filename)
    : language || 'plaintext';

  const lineCount = useMemo(() => {
    let n = 1;
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) n++;
    return n;
  }, [value]);

  const tooBig =
    value.length > MAX_HIGHLIGHT_BYTES || lineCount > MAX_HIGHLIGHT_LINES;
  const supported = SUPPORTED_LANGS.has(detectedLanguage);
  const shouldHighlight = supported && !tooBig;

  const html = useMemo(() => {
    if (!shouldHighlight) {
      // Fallback: escaped plain text inside a transparent <pre>.
      // Keep a trailing newline so the last line keeps its height during edit.
      const safe = escapeHtml(value.endsWith('\n') ? value : value + '\n');
      return `<pre class="shiki"><code>${safe}</code></pre>`;
    }
    try {
      return getHighlighter().codeToHtml(
        value.endsWith('\n') ? value : value + '\n',
        {
          lang: detectedLanguage,
          themes: { light: 'github-light', dark: 'github-dark' },
          defaultColor: false,
        }
      );
    } catch {
      const safe = escapeHtml(value.endsWith('\n') ? value : value + '\n');
      return `<pre class="shiki"><code>${safe}</code></pre>`;
    }
  }, [value, detectedLanguage, shouldHighlight]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange?.(e.target.value);
    },
    [onChange]
  );

  const handleScroll = useCallback((e: UIEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const pre = preRef.current;
    if (pre) {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd/Ctrl+S → save
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        onSave?.();
        return;
      }
      // Tab → insert two spaces (don't move focus)
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const indent = '  ';
        const next = value.slice(0, start) + indent + value.slice(end);
        onChange?.(next);
        // Restore cursor after React updates the value
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + indent.length;
        });
      }
    },
    [onSave, onChange, value]
  );

  const handleCompositionStart = useCallback(
    (_e: CompositionEvent<HTMLTextAreaElement>) => {
      setIsComposing(true);
    },
    []
  );

  const handleCompositionEnd = useCallback(
    (e: CompositionEvent<HTMLTextAreaElement>) => {
      setIsComposing(false);
      // The change event during composition may not fire on all browsers;
      // ensure the final composed text reaches the parent.
      onChange?.((e.target as HTMLTextAreaElement).value);
    },
    [onChange]
  );

  const wrapperClass = `text-editor-shiki relative h-full w-full overflow-hidden ${className ?? ''}`;

  const taStyle: CSSProperties = {
    ...sharedTextStyle,
    color: isComposing ? (isDark ? '#e6edf3' : '#1f2328') : 'transparent',
    caretColor: isDark ? '#e6edf3' : '#1f2328',
    background: 'transparent',
    resize: 'none',
    outline: 'none',
    width: '100%',
    height: '100%',
    overflow: 'auto',
  };

  const preStyle: CSSProperties = {
    ...sharedTextStyle,
    position: 'absolute',
    inset: 0,
    overflow: 'auto',
    pointerEvents: 'none',
    background: 'transparent',
  };

  return (
    <div className={wrapperClass}>
      <div
        ref={preRef}
        aria-hidden
        style={preStyle}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <textarea
        ref={taRef}
        value={value}
        onChange={handleChange}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        readOnly={readOnly}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        wrap="soft"
        style={taStyle}
      />
    </div>
  );
}

export { getLanguageFromFilename };
