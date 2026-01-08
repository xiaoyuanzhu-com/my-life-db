import { useState, useEffect, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { useParams, useNavigate } from "react-router";
import {
  ArrowLeft,
  FileText,
  Clock,
  Hash,
  HardDrive,
  Calendar,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  Sparkles,
  RotateCcw,
} from "lucide-react";
import type { FileRecord, Digest } from "~/types";
import { TranscriptViewer } from "~/components/transcript-viewer";

interface FileInfoData {
  file: FileRecord;
  digests: Digest[];
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return "N/A";
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
    case "completed":
      return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case "in-progress":
      return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
    case "failed":
      return <XCircle className="w-4 h-4 text-red-500" />;
    case "todo":
      return <AlertCircle className="w-4 h-4 text-yellow-500" />;
    case "skipped":
      return <AlertCircle className="w-4 h-4 text-gray-400" />;
    default:
      return <AlertCircle className="w-4 h-4 text-muted-foreground" />;
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case "completed":
      return "text-green-500";
    case "in-progress":
      return "text-blue-500";
    case "failed":
      return "text-red-500";
    case "todo":
      return "text-yellow-500";
    case "skipped":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

const TEXT_CONTENT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-sh",
]);

const DIGEST_POLL_INTERVAL = 2000;
const PENDING_DIGEST_STATUSES = new Set(["todo", "in-progress"]);

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

function isTextContent(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith("text/") || TEXT_CONTENT_TYPES.has(normalized);
}

interface DigestCardProps {
  digest: Digest;
  onAudioSeek?: (time: number) => void;
  onReset?: (digester: string) => void;
  isResetting?: boolean;
}

function DigestCard({ digest, onAudioSeek, onReset, isResetting }: DigestCardProps) {
  let parsedContent: any = null;
  if (digest.content) {
    try {
      parsedContent = JSON.parse(digest.content);
    } catch {
      // Content is not JSON, handled below
    }
  }

  const isScreenshot = digest.digester.toLowerCase().includes("screenshot");
  const screenshotSrc =
    isScreenshot && digest.sqlarName
      ? `/sqlar/${digest.sqlarName
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")}`
      : null;

  let contentBody: ReactNode | null = null;
  let showContentSection = true;

  if (screenshotSrc) {
    contentBody = (
      <div className="flex justify-center">
        <div className="w-full md:w-3/5 max-w-2xl">
          <div className="rounded-md overflow-hidden border bg-muted/50 relative">
            <img
              src={screenshotSrc}
              alt={`${digest.digester} screenshot`}
              className="w-full h-auto object-contain bg-black/5"
            />
          </div>
        </div>
      </div>
    );
  } else if (digest.digester === "url-crawl-content" && parsedContent) {
    const markdownContent = typeof parsedContent.markdown === "string" ? parsedContent.markdown : null;
    contentBody = markdownContent ? (
      <div className="p-2 bg-muted rounded text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
        {markdownContent}
      </div>
    ) : (
      <div className="text-sm text-muted-foreground">Markdown content unavailable.</div>
    );
  } else if (
    (digest.digester === "url-crawl-summary" || digest.digester === "summarize") &&
    parsedContent?.summary
  ) {
    contentBody = (
      <div className="p-2 bg-muted rounded text-sm whitespace-pre-wrap">{parsedContent.summary}</div>
    );
  } else if (digest.digester === "tags" && Array.isArray(parsedContent?.tags)) {
    contentBody = (
      <div className="flex flex-wrap gap-1">
        {parsedContent.tags.map((tag: string, idx: number) => (
          <span key={`${tag}-${idx}`} className="px-2 py-0.5 bg-primary/10 text-primary rounded-full text-xs">
            {tag}
          </span>
        ))}
      </div>
    );
  } else if (digest.digester === "search-keyword") {
    if (digest.error) {
      contentBody = (
        <div className="p-2 bg-destructive/10 rounded text-xs text-destructive">
          {digest.error}
        </div>
      );
    } else {
      showContentSection = false;
    }
  } else if (digest.digester === "search-semantic") {
    if (digest.error) {
      contentBody = (
        <div className="p-2 bg-destructive/10 rounded text-xs text-destructive">
          {digest.error}
        </div>
      );
    } else {
      showContentSection = false;
    }
  } else if (digest.digester === "speech-recognition" && parsedContent?.segments) {
    contentBody = <TranscriptViewer data={parsedContent} onSeek={onAudioSeek} />;
  } else if (parsedContent) {
    contentBody = (
      <div className="p-2 bg-muted rounded text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
        {JSON.stringify(parsedContent, null, 2)}
      </div>
    );
  } else if (digest.content) {
    contentBody = (
      <div className="p-2 bg-muted rounded text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
        {digest.content}
      </div>
    );
  } else if (digest.error) {
    contentBody = (
      <div className="p-2 bg-destructive/10 rounded text-xs text-destructive">
        {digest.error}
      </div>
    );
  } else if (showContentSection) {
    contentBody = <div className="text-sm text-muted-foreground">No content available.</div>;
  }

  const canReset = digest.status !== "in-progress" && digest.status !== "todo";

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{digest.digester}</span>
          {getStatusIcon(digest.status)}
          <span className={`text-xs ${getStatusColor(digest.status)}`}>{digest.status}</span>
        </div>
        {canReset && onReset && (
          <button
            onClick={() => onReset(digest.digester)}
            disabled={isResetting}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={`Reset and reprocess "${digest.digester}"`}
          >
            {isResetting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            Reset
          </button>
        )}
      </div>
      {showContentSection && contentBody !== null && <div className="pt-2 border-t text-sm space-y-2">{contentBody}</div>}
    </div>
  );
}

export default function FileInfoPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [fileInfo, setFileInfo] = useState<FileInfoData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDigesting, setIsDigesting] = useState(false);
  const [isPollingDigests, setIsPollingDigests] = useState(false);
  const [digestMessage, setDigestMessage] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [fileContentType, setFileContentType] = useState<string | null>(null);
  const [isContentLoading, setIsContentLoading] = useState(true);
  const [fileContentError, setFileContentError] = useState<string | null>(null);
  const [resettingDigester, setResettingDigester] = useState<string | null>(null);
  const digestPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handleAudioSeek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.readyState >= 1) {
      audio.currentTime = time;
      audio.play();
    } else {
      const onLoadedMetadata = () => {
        audio.currentTime = time;
        audio.play();
        audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      };
      audio.addEventListener("loadedmetadata", onLoadedMetadata);
      audio.load();
    }
  }, []);

  // Reconstruct file path from params
  const pathParam = params["*"] || "";
  const filePath = pathParam
    .split("/")
    .map(safeDecodeURIComponent)
    .join("/");

  const loadFileInfo = useCallback(
    async (options?: { background?: boolean }) => {
      if (!filePath) return;

      const isBackground = Boolean(options?.background);
      if (!isBackground) {
        setIsLoading(true);
        setError(null);
      }

      try {
        const response = await fetch(`/api/library/file-info?path=${encodeURIComponent(filePath)}`);

        if (!response.ok) {
          throw new Error("Failed to load file information");
        }

        const data = await response.json();
        setFileInfo(data);
      } catch (err) {
        console.error("Failed to load file info:", err);
        if (!isBackground) {
          setError(err instanceof Error ? err.message : "Failed to load file information");
        }
      } finally {
        if (!isBackground) {
          setIsLoading(false);
        }
      }
    },
    [filePath]
  );

  const loadFileContent = useCallback(async () => {
    if (!filePath) return;

    setIsContentLoading(true);
    setFileContent(null);
    setFilePreviewUrl(null);
    setFileContentType(null);
    setFileContentError(null);

    try {
      const encodedPath = filePath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const rawUrl = `/raw/${encodedPath}`;
      const response = await fetch(rawUrl);

      if (!response.ok) {
        throw new Error("Failed to load file content");
      }

      const responseContentType = response.headers.get("content-type") || null;
      setFileContentType(responseContentType);

      if (!isTextContent(responseContentType)) {
        if (responseContentType?.startsWith("image/") || responseContentType?.startsWith("audio/")) {
          setFilePreviewUrl(rawUrl);
          return;
        } else {
          setFileContentError(
            responseContentType
              ? `Preview not available for ${responseContentType} files`
              : "Preview not available for this file type"
          );
          return;
        }
      }

      const text = await response.text();
      setFileContent(text ?? "");
    } catch (err) {
      console.error("Failed to load file content:", err);
      setFileContentError(err instanceof Error ? err.message : "Failed to load file content");
    } finally {
      setIsContentLoading(false);
    }
  }, [filePath]);

  const stopDigestPolling = useCallback(() => {
    if (digestPollIntervalRef.current) {
      clearInterval(digestPollIntervalRef.current);
      digestPollIntervalRef.current = null;
    }
    setIsPollingDigests(false);
  }, []);

  useEffect(() => {
    if (!filePath) return;
    loadFileInfo();
  }, [filePath, loadFileInfo]);

  useEffect(() => {
    if (!filePath) return;
    loadFileContent();
  }, [filePath, loadFileContent]);

  useEffect(() => {
    if (!isPollingDigests) {
      return;
    }

    const runPoll = () => {
      void loadFileInfo({ background: true });
    };

    runPoll();
    digestPollIntervalRef.current = setInterval(runPoll, DIGEST_POLL_INTERVAL);

    return () => {
      if (digestPollIntervalRef.current) {
        clearInterval(digestPollIntervalRef.current);
        digestPollIntervalRef.current = null;
      }
    };
  }, [isPollingDigests, loadFileInfo]);

  useEffect(() => {
    if (!fileInfo) {
      stopDigestPolling();
      return;
    }

    const hasPending = fileInfo.digests.some((digest) => PENDING_DIGEST_STATUSES.has(digest.status));

    if (hasPending) {
      setIsPollingDigests(true);
    } else {
      stopDigestPolling();
    }
  }, [fileInfo, stopDigestPolling]);

  const handleBack = () => {
    navigate(`/library?open=${encodeURIComponent(filePath)}`);
  };

  const handleDigest = async () => {
    setIsDigesting(true);
    setDigestMessage(null);

    try {
      const response = await fetch(`/api/digest/${filePath}`, {
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to trigger digest");
      }

      const data = await response.json();
      setDigestMessage(data.message || "Digest processing started");
      setIsPollingDigests(true);
      await loadFileInfo({ background: true });
    } catch (err) {
      console.error("Failed to trigger digest:", err);
      setDigestMessage(err instanceof Error ? err.message : "Failed to trigger digest");
    } finally {
      setIsDigesting(false);
    }
  };

  const handleResetDigest = async (digester: string) => {
    setResettingDigester(digester);
    setDigestMessage(null);

    try {
      const response = await fetch(`/api/digest/${filePath}?digester=${encodeURIComponent(digester)}`, {
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to reset ${digester}`);
      }

      const data = await response.json();
      setDigestMessage(data.message || `${digester} reset complete`);
      setIsPollingDigests(true);
      await loadFileInfo({ background: true });
    } catch (err) {
      console.error("Failed to reset digest:", err);
      setDigestMessage(err instanceof Error ? err.message : `Failed to reset ${digester}`);
    } finally {
      setResettingDigester(null);
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
        <p className="text-muted-foreground">{error || "Failed to load file information"}</p>
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
    fileContentBody = <div className="px-6 py-8 text-sm text-muted-foreground">{fileContentError}</div>;
  } else if (filePreviewUrl && displayContentType?.startsWith("image/")) {
    fileContentBody = (
      <div className="flex items-center justify-center bg-muted/50">
        <div className="max-w-3xl w-full">
          <div className="relative w-full border-b">
            <img src={filePreviewUrl} alt={file.name} className="w-full h-auto object-contain bg-black/5" />
          </div>
        </div>
      </div>
    );
  } else if (filePreviewUrl && displayContentType?.startsWith("audio/")) {
    fileContentBody = (
      <div className="px-6 py-8">
        <audio ref={audioRef} controls preload="metadata" className="w-full" src={filePreviewUrl}>
          Your browser does not support the audio element.
        </audio>
      </div>
    );
  } else if (fileContent !== null) {
    fileContentBody =
      fileContent.length > 0 ? (
        <div className="px-6 py-4 bg-muted/50 max-h-[32rem] overflow-auto">
          <pre className="text-sm font-mono whitespace-pre-wrap break-words">{fileContent}</pre>
        </div>
      ) : (
        <div className="px-6 py-8 text-sm text-muted-foreground">File is empty.</div>
      );
  } else {
    fileContentBody = (
      <div className="px-6 py-8 text-sm text-muted-foreground">Preview not available for this file type.</div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* File Content */}
        <section>
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-muted-foreground tracking-wide normal-case">{file.name}</h2>
            {displayContentType && <p className="text-xs text-muted-foreground mt-0.5">{displayContentType}</p>}
          </div>
          <div className="border rounded-lg overflow-hidden">{fileContentBody}</div>
        </section>

        {/* File Metadata */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">File Metadata</h2>
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
                  <code className="text-sm">{file.mimeType || "unknown"}</code>
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
              {digestMessage && <span className="text-xs text-muted-foreground">{digestMessage}</span>}
              <button
                onClick={handleDigest}
                disabled={isDigesting}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium border rounded-lg hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Trigger AI digest processing for this file"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {isDigesting ? "Processing..." : "Digest"}
              </button>
            </div>
          </div>
          {digests.length > 0 ? (
            <div className="space-y-3">
              {digests.map((digest) => (
                <DigestCard
                  key={digest.id}
                  digest={digest}
                  onAudioSeek={displayContentType?.startsWith("audio/") ? handleAudioSeek : undefined}
                  onReset={handleResetDigest}
                  isResetting={resettingDigester === digest.digester}
                />
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
