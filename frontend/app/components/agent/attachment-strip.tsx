import type { StagedAttachment } from "~/hooks/use-agent-attachments"
import { AttachmentChip } from "./attachment-chip"

interface Props {
  items: StagedAttachment[]
  onRemove: (clientID: string) => void
}

export function AttachmentStrip({ items, onRemove }: Props) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-2">
      {items.map((item) => (
        <AttachmentChip
          key={item.clientID}
          item={item}
          onRemove={() => onRemove(item.clientID)}
        />
      ))}
    </div>
  )
}
