import { useCallback, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '~/components/ui/sheet'
import { Button } from '~/components/ui/button'
import { AutoAgentList } from './auto-agent-list'
import { AutoAgentEditor } from './auto-agent-editor'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the user clicks "Edit with AI" — parent seeds a session. */
  onEditWithAI: (name: string, markdown: string) => void
}

export function AutoAgentsSheet({ open, onOpenChange, onEditWithAI }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const handleSelect = useCallback((name: string) => {
    setSelected(name)
  }, [])

  const handleBack = useCallback(() => {
    setSelected(null)
  }, [])

  const handleSaved = useCallback(() => {
    setRefreshKey((n) => n + 1)
  }, [])

  const handleDeleted = useCallback(() => {
    setSelected(null)
    setRefreshKey((n) => n + 1)
  }, [])

  const handleEditWithAI = useCallback(
    (name: string, markdown: string) => {
      onEditWithAI(name, markdown)
      onOpenChange(false)
    },
    [onEditWithAI, onOpenChange]
  )

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) setSelected(null)
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-xl">
        {selected ? (
          <>
            <SheetHeader className="flex flex-row items-center gap-2 border-b border-border">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handleBack}
                title="Back to list"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <SheetTitle className="truncate">{selected}</SheetTitle>
              <SheetDescription className="sr-only">Auto agent editor</SheetDescription>
            </SheetHeader>
            <div className="flex-1 min-h-0 overflow-hidden">
              <AutoAgentEditor
                key={selected}
                name={selected}
                onSaved={handleSaved}
                onDeleted={handleDeleted}
                onEditWithAI={handleEditWithAI}
              />
            </div>
          </>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>Auto agents</SheetTitle>
              <SheetDescription>
                Markdown definitions with triggers that spawn sessions on your behalf.
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 min-h-0 overflow-y-auto p-3">
              <AutoAgentList activeName={null} onSelect={handleSelect} refreshKey={refreshKey} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
