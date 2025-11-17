'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileText, Clock, Hash, HardDrive, Calendar, CheckCircle2, XCircle, Loader2, AlertCircle } from 'lucide-react';
import type { FileRecord, Digest } from '@/types';

interface FileInfoData {
  file: FileRecord;
  digests: Digest[];
}

function formatFileSize(bytes: number): string {
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
    case 'enriched':
      return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case 'enriching':
      return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
    case 'failed':
      return <XCircle className="w-4 h-4 text-red-500" />;
    case 'pending':
      return <AlertCircle className="w-4 h-4 text-yellow-500" />;
    default:
      return <AlertCircle className="w-4 h-4 text-muted-foreground" />;
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'enriched':
      return 'text-green-600 dark:text-green-400';
    case 'enriching':
      return 'text-blue-600 dark:text-blue-400';
    case 'failed':
      return 'text-red-600 dark:text-red-400';
    case 'pending':
      return 'text-yellow-600 dark:text-yellow-400';
    default:
      return 'text-muted-foreground';
  }
}

function DigestCard({ digest }: { digest: Digest }) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Parse JSON content for tags and slug
  let parsedContent: any = null;
  if (digest.content && (digest.digestType === 'tags' || digest.digestType === 'slug')) {
    try {
      parsedContent = JSON.parse(digest.content);
    } catch (e) {
      // Invalid JSON, show raw content
    }
  }

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{digest.digestType}</span>
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
              {digest.digestType === 'tags' && parsedContent && Array.isArray(parsedContent) ? (
                <div className="flex flex-wrap gap-1">
                  {parsedContent.map((tag: string, idx: number) => (
                    <span
                      key={idx}
                      className="px-2 py-0.5 bg-primary/10 text-primary rounded-full text-xs"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : digest.digestType === 'slug' && parsedContent ? (
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

  // Reconstruct file path from params
  const filePath = Array.isArray(params.path) ? params.path.join('/') : params.path;

  useEffect(() => {
    if (!filePath) return;

    loadFileInfo();
  }, [filePath]);

  const loadFileInfo = async () => {
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
  };

  const handleBack = () => {
    // Navigate back to library with the file open
    router.push(`/library?open=${encodeURIComponent(filePath)}`);
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

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b sticky top-0 bg-background z-10">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center gap-4">
            <button
              onClick={handleBack}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <div className="flex items-center gap-2 flex-1">
              <FileText className="w-5 h-5 text-muted-foreground" />
              <h1 className="text-lg font-semibold truncate">{file.name}</h1>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
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
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
            Digests ({digests.length})
          </h2>
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
