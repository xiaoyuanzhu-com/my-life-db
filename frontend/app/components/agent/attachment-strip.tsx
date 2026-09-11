import { useState } from "react"
import type { StagedAttachment } from "~/hooks/use-agent-attachments"
import { ImageLightbox } from "~/components/ui/image-lightbox"
import { AttachmentChip, attachmentImageUrl } from "./attachment-chip"

interface Props {
  items: StagedAttachment[]
  onRemove: (clientID: string) => void
}

export function AttachmentStrip({ items, onRemove }: Props) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  if (items.length === 0) return null

  // All currently previewable images, in strip order — the lightbox can
  // swipe/arrow through them.
  const previews = items.flatMap((item) => {
    const src = attachmentImageUrl(item)
    return src ? [{ clientID: item.clientID, src }] : []
  })

  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-2">
      {items.map((item) => (
        <AttachmentChip
          key={item.clientID}
          item={item}
          onRemove={() => onRemove(item.clientID)}
          onPreview={() => {
            const idx = previews.findIndex((p) => p.clientID === item.clientID)
            if (idx >= 0) setPreviewIndex(idx)
          }}
        />
      ))}
      {previewIndex !== null && (
        <ImageLightbox
          images={previews}
          initialIndex={previewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </div>
  )
}
