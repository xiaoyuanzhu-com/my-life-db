'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, FileText, Clock, Hash, HardDrive, Calendar, CheckCircle2, XCircle, Loader2, AlertCircle, Sparkles } from 'lucide-react';
import type { FileRecord, Digest } from '@/types';

interface FileInfoData {
  file: FileRecord;
  digests: Digest[];
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return 'N/A';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleString();
}

function getStatusIcon(status: string) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case 'in-progress':
      return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
    case 'failed':
      return <XCircle className="w-4 h-4 text-red-500" />;
    case 'todo':
      return <AlertCircle className="w-4 h-4 text-yellow-500" />;
    case 'skipped':
      return <AlertCircle className="w-4 h-4 text-gray-400" />;
    default:
      return <AlertCircle className="w-4 h-4 text-muted-foreground" />;
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'text-green-600 dark:text-green-400';
    case 'in-progress':
      return 'text-blue-600 dark:text-blue-400';
    case 'failed':
      return 'text-red-600 dark:text-red-400';
    case 'todo':
      return 'text-yellow-600 dark:text-yellow-400';
    case 'skipped':
      return 'text-gray-600 dark:text-gray-400';
    default:
      return 'text-muted-foreground';
  }
}

const TEXT_CONTENT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-sh',
]);

function isTextContent(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.split(';')[0]?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith('text/') || TEXT_CONTENT_TYPES.has(normalized);
}

function DigestCard({ digest }: { digest: Digest }) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Parse JSON content (all digesters now use JSON except binary ones)
  let parsedContent: any = null;
  if (digest.content) {
    try {
      parsedContent = JSON.parse(digest.content);
    } catch {
      // Invalid JSON, show raw content (shouldn't happen with new format)
    }
  }

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{digest.digester}</span>
          {getStatusIcon(digest.status)}
          <span className={`text-xs ${getStatusColor(digest.status)}`}>
            {digest.status}
          </span>
        </div>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {isExpanded ? 'Hide' : 'Show'} Details
        </button>
      </div>

      {isExpanded && (
        <div className="space-y-2 pt-2 border-t text-sm">
          {/* Content */}
          {digest.content && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Content:</div>
              {digest.digester === 'url-crawl-content' && parsedContent ? (
                <div className="space-y-2">
                  {parsedContent.title && (
                    <div>
                      <span className="text-xs text-muted-foreground">Title: </span>
                      <span className="font-medium">{parsedContent.title}</span>
                    </div>
                  )}
                  {parsedContent.url && (
                    <div>
                      <span className="text-xs text-muted-foreground">URL: </span>
                      <a href={parsedContent.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline text-xs">
                        {parsedContent.url}
                      </a>
                    </div>
                  )}
                  {parsedContent.description && (
                    <div>
                      <span className="text-xs text-muted-foreground">Description: </span>
                      <span className="text-xs">{parsedContent.description}</span>
                    </div>
                  )}
                  {parsedContent.wordCount && (
                    <div>
                      <span className="text-xs text-muted-foreground">Word Count: </span>
                      <span className="text-xs">{parsedContent.wordCount} ({parsedContent.readingTimeMinutes} min read)</span>
                    </div>
                  )}
                  {parsedContent.markdown && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">Markdown:</div>
                      <div className="p-2 bg-muted rounded text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                        {parsedContent.markdown.slice(0, 500)}...
                      </div>
                    </div>
                  )}
                </div>
              ) : digest.digester === 'summarize' && parsedContent?.summary ? (
                <div className="p-2 bg-muted rounded text-sm whitespace-pre-wrap">
                  {parsedContent.summary}
                </div>
              ) : digest.digester === 'tagging' && parsedContent?.tags && Array.isArray(parsedContent.tags) ? (
                <div className="flex flex-wrap gap-1">
                  {parsedContent.tags.map((tag: string, idx: number) => (
                    <span
                      key={idx}
                      className="px-2 py-0.5 bg-primary/10 text-primary rounded-full text-xs"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : digest.digester === 'slug' && parsedContent ? (
                <div className="space-y-1">
                  {parsedContent.title && (
                    <div>
                      <span className="text-xs text-muted-foreground">Title: </span>
                      <span>{parsedContent.title}</span>
                    </div>
                  )}
                  {parsedContent.slug && (
                    <div>
                      <span className="text-xs text-muted-foreground">Slug: </span>
                      <code className="px-1 py-0.5 bg-muted rounded text-xs">{parsedContent.slug}</code>
                    </div>
                  )}
                </div>
              ) : parsedContent ? (
                <div className="p-2 bg-muted rounded text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                  {JSON.stringify(parsedContent, null, 2)}
                </div>
              ) : (
                <div className="p-2 bg-muted rounded text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                  {digest.content}
                </div>
              )}
            </div>
          )}

          {/* SQLAR reference */}
          {digest.sqlarName && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Archived File:</div>
              <code className="px-2 py-1 bg-muted rounded text-xs">{digest.sqlarName}</code>
            </div>
          )}

          {/* Error message */}
          {digest.error && (
            <div>
              <div className="text-xs text-red-600 dark:text-red-400 mb-1">Error:</div>
              <div className="p-2 bg-red-50 dark:bg-red-950/20 rounded text-xs text-red-700 dark:text-red-300">
                {digest.error}
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Created: </span>
              <span>{formatDate(digest.createdAt)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Updated: </span>
              <span>{formatDate(digest.updatedAt)}</span>
            </div>
          </div>

          {/* Digest ID */}
          <div className="text-xs">
            <span className="text-muted-foreground">ID: </span>
            <code className="text-xs">{digest.id}</code>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FileInfoPage() {
  const params = useParams();
  const router = useRouter();
  const [fileInfo, setFileInfo] = useState<FileInfoData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDigesting, setIsDigesting] = useState(false);
  const [digestMessage, setDigestMessage] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentType, setFileContentType] = useState<string | null>(null);
  const [isContentLoading, setIsContentLoading] = useState(true);
  const [fileContentError, setFileContentError] = useState<string | null>(null);

  // Reconstruct file path from params
  const filePath = Array.isArray(params.path) ? params.path.join('/') : params.path ?? '';

  const loadFileInfo = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/library/file-info?path=${encodeURIComponent(filePath)}`);

      if (!response.ok) {
        throw new Error('Failed to load file information');
      }

      const data = await response.json();
      setFileInfo(data);
    } catch (err) {
      console.error('Failed to load file info:', err);
      setError(err instanceof Error ? err.message : 'Failed to load file information');
    } finally {
      setIsLoading(false);
    }
  }, [filePath]);

  const loadFileContent = useCallback(async () => {
    if (!filePath) return;

    setIsContentLoading(true);
    setFileContent(null);
    setFileContentType(null);
    setFileContentError(null);

    try {
      const encodedPath = filePath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const response = await fetch(`/raw/${encodedPath}`);

      if (!response.ok) {
        throw new Error('Failed to load file content');
      }

      const responseContentType = response.headers.get('content-type') || null;
      setFileContentType(responseContentType);

      if (!isTextContent(responseContentType)) {
        setFileContent(null);
        setFileContentError(
          responseContentType
            ? `Preview not available for ${responseContentType} files`
            : 'Preview not available for this file type'
        );
        return;
      }

      const text = await response.text();
      setFileContent(text ?? '');
    } catch (err) {
      console.error('Failed to load file content:', err);
      setFileContentError(err instanceof Error ? err.message : 'Failed to load file content');
    } finally {
      setIsContentLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    if (!filePath) return;
    loadFileInfo();
  }, [filePath, loadFileInfo]);

  useEffect(() => {
    if (!filePath) return;
    loadFileContent();
  }, [filePath, loadFileContent]);

  const handleBack = () => {
    // Navigate back to library with the file open
    router.push(`/library?open=${encodeURIComponent(filePath)}`);
  };

  const handleDigest = async () => {
    setIsDigesting(true);
    setDigestMessage(null);

    try {
      const response = await fetch(`/api/digest/${filePath}`, {
        method: 'POST',
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to trigger digest');
      }

      const data = await response.json();
      setDigestMessage(data.message || 'Digest processing started');

      // Reload file info after a short delay to show updated digests
      setTimeout(() => {
        loadFileInfo();
      }, 2000);
    } catch (err) {
      console.error('Failed to trigger digest:', err);
      setDigestMessage(err instanceof Error ? err.message : 'Failed to trigger digest');
    } finally {
      setIsDigesting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !fileInfo) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <XCircle className="w-12 h-12 text-red-500" />
        <p className="text-muted-foreground">{error || 'Failed to load file information'}</p>
        <button
          onClick={handleBack}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Library
        </button>
      </div>
    );
  }

  const { file, digests } = fileInfo;
  const displayContentType = fileContentType || file.mimeType || null;

  let fileContentBody;
  if (isContentLoading) {
    fileContentBody = (
      <div className="flex items-center gap-2 px-6 py-16 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading content...
      </div>
    );
  } else if (fileContentError) {
    fileContentBody = (
      <div className="px-6 py-8 text-sm text-muted-foreground">{fileContentError}</div>
    );
  } else if (fileContent !== null) {
    fileContentBody = fileContent.length > 0 ? (
      <div className="px-6 py-4 bg-muted/50 max-h-[32rem] overflow-auto">
        <pre className="text-sm font-mono whitespace-pre-wrap break-words">{fileContent}</pre>
      </div>
    ) : (
      <div className="px-6 py-8 text-sm text-muted-foreground">File is empty.</div>
    );
  } else {
    fileContentBody = (
      <div className="px-6 py-8 text-sm text-muted-foreground">
        Preview not available for this file type.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* File Content */}
        <section>
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-muted-foreground tracking-wide normal-case">
              {file.name}
            </h2>
            {displayContentType && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {displayContentType}
              </p>
            )}
          </div>
          <div className="border rounded-lg overflow-hidden">
            {fileContentBody}
          </div>
        </section>

        {/* File Metadata */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
            File Metadata
          </h2>
          <div className="border rounded-lg p-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-start gap-3">
                <FileText className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div>
                  <div className="text-xs text-muted-foreground">Path</div>
                  <code className="text-sm">{file.path}</code>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <HardDrive className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div>
                  <div className="text-xs text-muted-foreground">Size</div>
                  <div className="text-sm">{formatFileSize(file.size)}</div>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <FileText className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div>
                  <div className="text-xs text-muted-foreground">MIME Type</div>
                  <code className="text-sm">{file.mimeType || 'unknown'}</code>
                </div>
              </div>

              {file.hash && (
                <div className="flex items-start gap-3">
                  <Hash className="w-5 h-5 text-muted-foreground mt-0.5" />
                  <div>
                    <div className="text-xs text-muted-foreground">SHA-256 Hash</div>
                    <code className="text-xs break-all">{file.hash}</code>
                  </div>
                </div>
              )}

              <div className="flex items-start gap-3">
                <Calendar className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div>
                  <div className="text-xs text-muted-foreground">Created</div>
                  <div className="text-sm">{formatDate(file.createdAt)}</div>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Clock className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div>
                  <div className="text-xs text-muted-foreground">Modified</div>
                  <div className="text-sm">{formatDate(file.modifiedAt)}</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Digests */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Digests ({digests.length})
            </h2>
            <div className="flex items-center gap-3">
              {digestMessage && (
                <span className="text-xs text-muted-foreground">{digestMessage}</span>
              )}
              <button
                onClick={handleDigest}
                disabled={isDigesting}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium border rounded-lg hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Trigger AI digest processing for this file"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {isDigesting ? 'Processing...' : 'Generate Digest'}
              </button>
            </div>
          </div>
          {digests.length > 0 ? (
            <div className="space-y-3">
              {digests.map((digest) => (
                <DigestCard key={digest.id} digest={digest} />
              ))}
            </div>
          ) : (
            <div className="border rounded-lg p-8 text-center text-muted-foreground">
              No digests available for this file
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
