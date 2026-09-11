import { XIcon, FileIcon, ImageIcon, Loader2 } from "lucide-react"
import { cn } from "~/lib/utils"
import type { StagedAttachment } from "~/hooks/use-agent-attachments"

interface Props {
  item: StagedAttachment
  onRemove: () => void
  onPreview?: () => void
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function isImageItem(item: StagedAttachment): boolean {
  const s = item.state
  return (
    (s.status === "ready" && s.attachment.contentType?.startsWith("image/")) ||
    (s.status !== "ready" && s.file.type.startsWith("image/"))
  ) === true
}

/**
 * Best URL to render an image attachment from: the local object URL when we
 * have the File (web paste/pick, any state), else the staged copy via /raw/
 * (ready items added through the native iOS bridge have no local File).
 */
export function attachmentImageUrl(item: StagedAttachment): string | undefined {
  if (!isImageItem(item)) return undefined
  if (item.previewUrl) return item.previewUrl
  const s = item.state
  if (s.status === "ready") {
    return `/raw/sessions/${encodeURIComponent(s.attachment.storageId)}/uploads/${encodeURIComponent(s.attachment.filename)}`
  }
  return undefined
}

export function AttachmentChip({ item, onRemove, onPreview }: Props) {
  const s = item.state
  const filename =
    s.status === "ready"
      ? s.attachment.filename
      : s.file.name
  const size = s.status === "ready" ? s.attachment.size : s.file.size
  const imageUrl = attachmentImageUrl(item)

  if (isImageItem(item)) {
    return (
      <div
        className={cn(
          "relative size-14 shrink-0 overflow-hidden rounded-md bg-muted",
          s.status === "error" && "ring-1 ring-destructive/50",
        )}
        title={s.status === "error" ? `${filename} — ${s.error}` : filename}
      >
        <button
          type="button"
          onClick={imageUrl ? onPreview : undefined}
          disabled={!imageUrl}
          className={cn(
            "block h-full w-full",
            imageUrl && "cursor-pointer hover:opacity-80",
          )}
          aria-label={`Preview ${filename}`}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={filename}
              className="h-full w-full object-cover"
            />
          ) : (
            <ImageIcon className="absolute inset-0 m-auto size-5 text-muted-foreground" />
          )}
        </button>
        {s.status === "uploading" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 className="size-4 animate-spin text-white" />
          </div>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="absolute top-0.5 right-0.5 rounded-full bg-black/55 p-0.5 text-white hover:bg-black/75"
          aria-label={`Remove ${filename}`}
        >
          <XIcon className="size-3" />
        </button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md bg-muted/70 px-2 py-1 text-xs max-w-[240px]",
        s.status === "error" && "bg-destructive/10 text-destructive",
      )}
      title={s.status === "error" ? `${filename} — ${s.error}` : filename}
    >
      {s.status === "uploading" ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{filename}</span>
      <span className="text-muted-foreground/70 shrink-0">
        {s.status === "uploading" ? `${s.progress}%` : humanSize(size)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
        aria-label={`Remove ${filename}`}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}
