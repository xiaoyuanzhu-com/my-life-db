import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useFormatter } from "~/lib/i18n/use-formatter";
import { useParams, useNavigate } from "react-router";
import {
  ArrowLeft,
  FileText,
  Clock,
  Hash,
  HardDrive,
  Calendar,
  XCircle,
  Loader2,
} from "lucide-react";
import type { FileRecord } from "~/types";
import { api } from "~/lib/api";

interface FileInfoData extends FileRecord {
  isPinned: boolean;
}

const TEXT_CONTENT_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/javascript",
  "application/x-sh",
]);

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

export default function FileInfoPage() {
  const { t } = useTranslation('data');
  const params = useParams();
  const navigate = useNavigate();
  const fmt = useFormatter();
  const [fileInfo, setFileInfo] = useState<FileInfoData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [fileContentType, setFileContentType] = useState<string | null>(null);
  const [isContentLoading, setIsContentLoading] = useState(true);
  const [fileContentError, setFileContentError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Reconstruct file path from params
  const pathParam = params["*"] || "";
  const filePath = pathParam
    .split("/")
    .map(safeDecodeURIComponent)
    .join("/");

  const loadFileInfo = useCallback(async () => {
    if (!filePath) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await api.get(`/api/library/file-info?path=${encodeURIComponent(filePath)}`);

      if (!response.ok) {
        throw new Error("Failed to load file information");
      }

      const data = await response.json();
      setFileInfo(data);
    } catch (err) {
      console.error("Failed to load file info:", err);
      setError(err instanceof Error ? err.message : "Failed to load file information");
    } finally {
      setIsLoading(false);
    }
  }, [filePath]);

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
      const response = await api.get(rawUrl);

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

  useEffect(() => {
    if (!filePath) return;
    loadFileInfo();
  }, [filePath, loadFileInfo]);

  useEffect(() => {
    if (!filePath) return;
    loadFileContent();
  }, [filePath, loadFileContent]);

  const handleBack = () => {
    navigate(-1);
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

  const file = fileInfo;
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
        <div className="px-6 py-8 text-sm text-muted-foreground">{t('file.metadata.empty')}</div>
      );
  } else {
    fileContentBody = (
      <div className="px-6 py-8 text-sm text-muted-foreground">{t('file.metadata.cannotPreview')}</div>
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
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">{t('file.metadata.title')}</h2>
          <div className="border rounded-lg p-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-start gap-3">
                <FileText className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div>
                  <div className="text-xs text-muted-foreground">{t('file.metadata.path')}</div>
                  <code className="text-sm">{file.path}</code>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <HardDrive className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div>
                  <div className="text-xs text-muted-foreground">{t('file.metadata.size')}</div>
                  <div className="text-sm">{fmt.fileSize(file.size)}</div>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <FileText className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div>
                  <div className="text-xs text-muted-foreground">{t('file.metadata.mimeType')}</div>
                  <code className="text-sm">{file.mimeType || "unknown"}</code>
                </div>
              </div>

              {file.hash && (
                <div className="flex items-start gap-3">
                  <Hash className="w-5 h-5 text-muted-foreground mt-0.5" />
                  <div>
                    <div className="text-xs text-muted-foreground">{t('file.metadata.sha256')}</div>
                    <code className="text-xs break-all">{file.hash}</code>
                  </div>
                </div>
              )}

              <div className="flex items-start gap-3">
                <Calendar className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div>
                  <div className="text-xs text-muted-foreground">{t('file.metadata.created')}</div>
                  <div className="text-sm">{fmt.dateTime(file.createdAt)}</div>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Clock className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div>
                  <div className="text-xs text-muted-foreground">{t('file.metadata.modified')}</div>
                  <div className="text-sm">{fmt.dateTime(file.modifiedAt)}</div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
