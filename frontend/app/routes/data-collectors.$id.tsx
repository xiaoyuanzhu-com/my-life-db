import { useState, useCallback, type ComponentType } from "react";
import { useParams, Link } from "react-router";
import {
  ArrowLeft, Clock, Heart, UtensilsCrossed, MessageCircle, BookOpen,
  Monitor, Calendar, Target, Footprints, HeartPulse, Moon,
  Scale, Brain, Dumbbell, Droplets, Coffee, Utensils, Pill,
  MessageSquare, Mail, Phone, Share2, FileText, Play,
  Headphones, Bot, Music, Terminal, Camera,
} from "lucide-react";
import { Switch } from "~/components/ui/switch";
import { useAuth } from "~/contexts/auth-context";
import {
  findCollector,
  statusConfig,
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
// Category accent colors
// ---------------------------------------------------------------------------

const categoryAccent: Record<string, string> = {
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
// Page
// ---------------------------------------------------------------------------

export default function DataCollectorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  if (authLoading) return null;
  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Sign in to manage data collectors.</p>
      </div>
    );
  }

  const result = id ? findCollector(id) : null;
  if (!result) {
    return (
      <div className="w-full px-4 py-6 md:px-[10%]">
        <Link to="/data-collectors" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>
        <p className="text-muted-foreground">Collector not found.</p>
      </div>
    );
  }

  const { category, collector } = result;
  const Icon = getIcon(collector.icon);
  const accent = categoryAccent[category.id] ?? "bg-muted text-muted-foreground";

  return (
    <div className="w-full px-4 py-6 md:px-[10%] pb-20">
      {/* Back link */}
      <Link
        to="/data-collectors"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Data Collectors
      </Link>

      {/* Header */}
      <div className="flex items-center gap-4 mb-8 animate-slide-up-fade" style={{ animationFillMode: "both" }}>
        <div className={`flex items-center justify-center w-12 h-12 rounded-xl ${accent}`}>
          <Icon className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{collector.name}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{collector.description}</p>
        </div>
      </div>

      {/* Breadcrumb context */}
      <div className="text-xs text-muted-foreground mb-6">
        {category.name} &rsaquo; {collector.name} &middot; {collector.sources.length} data {collector.sources.length === 1 ? "source" : "sources"}
      </div>

      {/* Sources list */}
      <div className="space-y-2">
        {collector.sources.map((source, i) => (
          <SourceRow key={source.id} source={source} index={i} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source Row
// ---------------------------------------------------------------------------

function SourceRow({ source, index }: { source: DataSource; index: number }) {
  const storageKey = `dataCollect.${source.id}`;
  const [enabled, setEnabled] = useState(() => localStorage.getItem(storageKey) === "true");

  const toggle = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    localStorage.setItem(storageKey, String(next));
    // Notify list page of change
    window.dispatchEvent(new CustomEvent("dataCollectChange"));
  }, [enabled, storageKey]);

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

      {/* Toggle */}
      <Switch
        checked={enabled}
        onCheckedChange={toggle}
      />
    </div>
  );
}
