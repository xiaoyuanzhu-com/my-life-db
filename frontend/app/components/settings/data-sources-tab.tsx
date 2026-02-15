import { useState, useEffect, useCallback, type ComponentType } from "react";
import {
  ArrowLeft, Clock, Heart, UtensilsCrossed, MessageCircle, BookOpen,
  Monitor, Calendar, Target, Footprints, HeartPulse, Moon,
  Scale, Brain, Dumbbell, Droplets, Coffee, Utensils, Pill,
  MessageSquare, Mail, Phone, Share2, FileText, Play,
  Headphones, Bot, Music, Terminal, Camera, Loader2,
} from "lucide-react";
import { Switch } from "~/components/ui/switch";
import { api } from "~/lib/api";
import {
  categories,
  findCollector,
  statusConfig,
  type Collector,
  type DataSource,
} from "~/lib/data-collectors";

// ---------------------------------------------------------------------------
// Icon map
// ---------------------------------------------------------------------------

const iconMap: Record<string, ComponentType<{ className?: string }>> = {
  Clock, Heart, UtensilsCrossed, MessageCircle, BookOpen,
  Monitor, Calendar, Target, Footprints, HeartPulse, Moon,
  Scale, Brain, Dumbbell, Droplets, Coffee, Utensils, Pill,
  MessageSquare, Mail, Phone, Share2, FileText, Play,
  Headphones, Bot, Music, Terminal, Camera,
};

function getIcon(name: string) {
  return iconMap[name] ?? Clock;
}

// ---------------------------------------------------------------------------
// Category accent colors (solid dot for grid tiles)
// ---------------------------------------------------------------------------

const categoryAccent: Record<string, string> = {
  time: "bg-blue-500",
  health: "bg-emerald-500",
  diet: "bg-amber-500",
  communication: "bg-violet-500",
  content: "bg-rose-500",
};

// ---------------------------------------------------------------------------
// Category accent colors (for detail header icon badge)
// ---------------------------------------------------------------------------

const categoryAccentBadge: Record<string, string> = {
  time: "bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400",
  health: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400",
  diet: "bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400",
  communication: "bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-400",
  content: "bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-400",
};

const statusDot: Record<string, string> = {
  available: "bg-emerald-500",
  limited: "bg-amber-500",
  manual: "bg-blue-500",
  future: "bg-muted-foreground/40",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CollectorState {
  id: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// DataSourcesTab
// ---------------------------------------------------------------------------

export function DataSourcesTab() {
  const [collectorStates, setCollectorStates] = useState<CollectorState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Fetch collector enabled states from API
  useEffect(() => {
    let cancelled = false;
    async function fetchCollectors() {
      setIsLoading(true);
      try {
        const res = await api.get("/api/collectors");
        if (res.ok) {
          const data: CollectorState[] = await res.json();
          if (!cancelled) {
            setCollectorStates(Array.isArray(data) ? data : []);
          }
        }
      } catch (error) {
        console.error("Failed to fetch collectors:", error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void fetchCollectors();
    return () => { cancelled = true; };
  }, []);

  const isCollectorEnabled = useCallback(
    (id: string): boolean => {
      const state = collectorStates.find((s) => s.id === id);
      return state?.enabled ?? false;
    },
    [collectorStates]
  );

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      // Optimistic update
      setCollectorStates((prev) => {
        const existing = prev.find((s) => s.id === id);
        if (existing) {
          return prev.map((s) => (s.id === id ? { ...s, enabled } : s));
        }
        return [...prev, { id, enabled }];
      });

      try {
        const res = await api.put(`/api/collectors/${id}`, { enabled });
        if (!res.ok) {
          throw new Error("Failed to update collector");
        }
      } catch (error) {
        console.error("Failed to toggle collector:", error);
        // Revert on error
        setCollectorStates((prev) => {
          const existing = prev.find((s) => s.id === id);
          if (existing) {
            return prev.map((s) => (s.id === id ? { ...s, enabled: !enabled } : s));
          }
          return prev.filter((s) => s.id !== id);
        });
      }
    },
    []
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Detail view
  if (selectedId) {
    return (
      <DetailView
        collectorId={selectedId}
        isEnabled={isCollectorEnabled(selectedId)}
        onToggle={handleToggle}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  // Grid view
  return (
    <div className="space-y-8">
      {categories.map((cat, catIdx) => {
        const activeColor = categoryAccent[cat.id] ?? "bg-muted-foreground";

        return (
          <section
            key={cat.id}
            className="animate-slide-up-fade"
            style={{ animationDelay: `${catIdx * 50}ms`, animationFillMode: "both" }}
          >
            <h2 className="text-lg font-bold text-foreground mb-3">{cat.name}</h2>

            <div className="grid grid-cols-5 sm:grid-cols-7 lg:grid-cols-9 gap-0.5">
              {cat.collectors.map((collector) => (
                <CollectorTile
                  key={collector.id}
                  collector={collector}
                  activeColor={activeColor}
                  isActive={isCollectorEnabled(collector.id)}
                  onClick={() => setSelectedId(collector.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tile (square)
// ---------------------------------------------------------------------------

function CollectorTile({
  collector,
  activeColor,
  isActive,
  onClick,
}: {
  collector: Collector;
  activeColor: string;
  isActive: boolean;
  onClick: () => void;
}) {
  const Icon = getIcon(collector.icon);

  return (
    <button onClick={onClick} className="group text-left">
      <div className={`
        aspect-square rounded-lg flex flex-col items-center justify-center gap-1 relative p-1
        border transition-colors duration-100
        ${isActive
          ? "bg-card border-foreground/10"
          : "bg-transparent border-transparent hover:bg-muted"
        }
      `}>
        <Icon className={`w-5 h-5 shrink-0 ${isActive ? "text-foreground" : "text-muted-foreground/60"}`} />
        <span className={`text-[10px] text-center leading-tight ${isActive ? "font-medium" : "text-muted-foreground/80"}`}>
          {collector.name}
        </span>
        {isActive && (
          <span className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ${activeColor}`} />
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Detail View
// ---------------------------------------------------------------------------

function DetailView({
  collectorId,
  isEnabled,
  onToggle,
  onBack,
}: {
  collectorId: string;
  isEnabled: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onBack: () => void;
}) {
  const result = findCollector(collectorId);
  if (!result) {
    return (
      <div>
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <p className="text-muted-foreground">Collector not found.</p>
      </div>
    );
  }

  const { category, collector } = result;
  const Icon = getIcon(collector.icon);
  const accent = categoryAccentBadge[category.id] ?? "bg-muted text-muted-foreground";

  return (
    <div className="animate-slide-up-fade" style={{ animationFillMode: "both" }}>
      {/* Back button */}
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Data Sources
      </button>

      {/* Header with toggle */}
      <div className="flex items-center gap-4 mb-8">
        <div className={`flex items-center justify-center w-12 h-12 rounded-xl ${accent}`}>
          <Icon className="w-6 h-6" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">{collector.name}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{collector.description}</p>
        </div>
        <Switch
          checked={isEnabled}
          onCheckedChange={(checked) => onToggle(collectorId, checked)}
        />
      </div>

      {/* Breadcrumb context */}
      <div className="text-xs text-muted-foreground mb-6">
        {category.name} &rsaquo; {collector.name} &middot; {collector.sources.length} data {collector.sources.length === 1 ? "source" : "sources"}
      </div>

      {/* Sources list (informational, no individual toggles) */}
      <div className="space-y-2">
        {collector.sources.map((source, i) => (
          <SourceRow key={source.id} source={source} index={i} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source Row (informational only, no toggle)
// ---------------------------------------------------------------------------

function SourceRow({ source, index }: { source: DataSource; index: number }) {
  const { label, className: statusClassName } = statusConfig[source.status];

  return (
    <div
      className="bg-card border rounded-xl px-4 py-3 flex items-center gap-4 animate-slide-up-fade"
      style={{ animationDelay: `${(index + 1) * 50}ms`, animationFillMode: "both" }}
    >
      {/* Status dot */}
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot[source.status]}`} />

      {/* Source info */}
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{source.name}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {source.description}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className={`text-[11px] ${statusClassName}`}>{label}</span>
          <span className="text-[11px] text-muted-foreground">&middot;</span>
          <span className="text-[11px] text-muted-foreground">{source.platform}</span>
        </div>
      </div>
    </div>
  );
}
