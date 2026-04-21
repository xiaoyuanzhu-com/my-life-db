import { useMemo, useState } from "react";
import { useApps } from "~/hooks/use-apps";
import { AppCard } from "./app-card";
import { cn } from "~/lib/utils";

type CategoryFilter = "all" | "social" | "chat" | "cloud" | "notes" | "health" | "media" | "finance" | "other";

interface Props {
  onSelect: (id: string) => void;
}

export function AppsCatalog({ onSelect }: Props) {
  const { data: apps, isLoading, error } = useApps();
  const [filter, setFilter] = useState<CategoryFilter>("all");

  const visible = useMemo(() => {
    if (!apps) return [];
    if (filter === "all") return apps;
    return apps.filter((a) => a.category === filter);
  }, [apps, filter]);

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (error) return <div className="p-4 text-sm text-destructive">Failed to load apps</div>;
  if (!apps || apps.length === 0) return <div className="p-4 text-sm text-muted-foreground">No apps registered.</div>;

  const categories: CategoryFilter[] = ["all", "social", "chat", "cloud", "notes", "health"];

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Filter pills */}
      <div className="flex gap-1 px-4 py-2 flex-wrap">
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setFilter(c)}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium capitalize",
              filter === c ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {c}
          </button>
        ))}
      </div>
      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-1">
          {visible.map((app) => (
            <AppCard key={app.id} app={app} onClick={() => onSelect(app.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}
