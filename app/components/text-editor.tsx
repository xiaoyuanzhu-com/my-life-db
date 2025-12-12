import { useEffect, useState, useCallback, useRef } from 'react';
import Editor, { type OnMount, type OnChange } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';

interface TextEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  className?: string;
  onSave?: () => void;
}

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    md: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    lua: 'lua',
    r: 'r',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
  };
  return languageMap[ext || ''] || 'plaintext';
}

function useTheme(): 'vs' | 'vs-dark' {
  const [theme, setTheme] = useState<'vs' | 'vs-dark'>('vs');

  useEffect(() => {
    const updateTheme = () => {
      const isDark =
        document.documentElement.classList.contains('dark') ||
        (!document.documentElement.classList.contains('light') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      setTheme(isDark ? 'vs-dark' : 'vs');
    };

    updateTheme();

    // Watch for class changes on <html>
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    // Also watch for system preference changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', updateTheme);

    return () => {
      observer.disconnect();
      mediaQuery.removeEventListener('change', updateTheme);
    };
  }, []);

  return theme;
}

export function TextEditor({
  value,
  onChange,
  language = 'plaintext',
  readOnly = false,
  className,
  onSave,
}: TextEditorProps) {
  const theme = useTheme();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  const handleEditorDidMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      // Add Cmd+S / Ctrl+S save action
      if (onSave) {
        editor.addAction({
          id: 'save-file',
          label: 'Save File',
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: () => {
            onSave();
          },
        });
      }
    },
    [onSave]
  );

  const handleChange: OnChange = useCallback(
    (value) => {
      if (onChange && value !== undefined) {
        onChange(value);
      }
    },
    [onChange]
  );

  return (
    <Editor
      className={className}
      value={value}
      language={language}
      theme={theme}
      onChange={handleChange}
      onMount={handleEditorDidMount}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        lineNumbers: 'off',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        automaticLayout: true,
        tabSize: 2,
        insertSpaces: true,
        renderWhitespace: 'selection',
        bracketPairColorization: { enabled: true },
        padding: { top: 12, bottom: 12 },
        scrollbar: {
          verticalScrollbarSize: 10,
          horizontalScrollbarSize: 10,
        },
        folding: false,
        glyphMargin: false,
        lineDecorationsWidth: 12,
        lineNumbersMinChars: 0,
        renderLineHighlight: 'none',
      }}
      loading={
        <div className="flex items-center justify-center h-full text-muted-foreground">
          Loading editor...
        </div>
      }
    />
  );
}

export { getLanguageFromFilename };
