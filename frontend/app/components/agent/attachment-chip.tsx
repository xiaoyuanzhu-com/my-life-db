import { XIcon, FileIcon, ImageIcon, Loader2 } from "lucide-react"
import { cn } from "~/lib/utils"
import type { StagedAttachment } from "~/hooks/use-agent-attachments"

interface Props {
  item: StagedAttachment
  onRemove: () => void
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function AttachmentChip({ item, onRemove }: Props) {
  const s = item.state
  const filename =
    s.status === "ready"
      ? s.attachment.filename
      : s.file.name
  const size = s.status === "ready" ? s.attachment.size : s.file.size
  const isImage =
    (s.status === "ready" && s.attachment.contentType?.startsWith("image/")) ||
    (s.status !== "ready" && s.file.type.startsWith("image/"))

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
      ) : isImage ? (
        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
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
