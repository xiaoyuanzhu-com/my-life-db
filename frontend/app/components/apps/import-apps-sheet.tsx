import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { AppsCatalog } from "./apps-catalog";
import { AppDetail } from "./app-detail";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportAppsSheet({ open, onOpenChange }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) setSelectedId(null);
        onOpenChange(v);
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-xl p-0 flex flex-col">
        <SheetHeader className="px-4 py-3 border-b border-border">
          <SheetTitle>Import from app</SheetTitle>
        </SheetHeader>
        <div className="flex-1 min-h-0">
          {selectedId ? (
            <AppDetail id={selectedId} onBack={() => setSelectedId(null)} />
          ) : (
            <AppsCatalog onSelect={setSelectedId} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
