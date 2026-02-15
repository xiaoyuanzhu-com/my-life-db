import { useState, useEffect, useMemo, type ComponentType } from "react";
import { Link } from "react-router";
import {
  Clock, Heart, UtensilsCrossed, MessageCircle, BookOpen,
  Monitor, Calendar, Target, Footprints, HeartPulse, Moon,
  Scale, Brain, Dumbbell, Droplets, Coffee, Utensils, Pill,
  MessageSquare, Mail, Phone, Share2, FileText, Play,
  Headphones, Bot, Music, Terminal, Camera, ChevronRight,
} from "lucide-react";
import { useAuth } from "~/contexts/auth-context";
import {
  categories,
  countEnabled,
  countCollectorEnabled,
  dominantStatus,
  statusConfig,
  type CollectorCategory,
  type Collector,
} from "~/lib/data-collectors";

// ---------------------------------------------------------------------------
// Icon map — maps string names to lucide components
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
// Category accent colors (used for section icon backgrounds)
// ---------------------------------------------------------------------------

const categoryAccent: Record<string, string> = {
  time: "bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400",
  health: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400",
  diet: "bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400",
  communication: "bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-400",
  content: "bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-400",
};

// ---------------------------------------------------------------------------
// Collector card accent (dot color)
// ---------------------------------------------------------------------------

const statusDot: Record<string, string> = {
  available: "bg-emerald-500",
  limited: "bg-amber-500",
  manual: "bg-blue-500",
  future: "bg-muted-foreground/40",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DataCollectorsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [_, setTick] = useState(0);

  // Re-render when localStorage toggles change (detail page writes them)
  useEffect(() => {
    const handler = () => setTick((t) => t + 1);
    window.addEventListener("storage", handler);
    window.addEventListener("dataCollectChange", handler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("dataCollectChange", handler);
    };
  }, []);

  if (authLoading) return null;
  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Sign in to manage data collectors.</p>
      </div>
    );
  }

  return (
    <div className="w-full px-4 py-6 md:px-[10%] space-y-10 pb-20">
      {/* Page header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Data Collectors</h1>
        <p className="text-muted-foreground mt-1">
          Manage what data flows into your life database
        </p>
      </div>

      {/* Category sections */}
      {categories.map((cat, catIdx) => (
        <CategorySection key={cat.id} category={cat} index={catIdx} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category Section
// ---------------------------------------------------------------------------

function CategorySection({ category, index }: { category: CollectorCategory; index: number }) {
  const Icon = getIcon(category.icon);
  const accent = categoryAccent[category.id] ?? "bg-muted text-muted-foreground";
  const { enabled, total } = useMemo(() => countEnabled(category), [category]);

  return (
    <section
      className="animate-slide-up-fade"
      style={{ animationDelay: `${index * 60}ms`, animationFillMode: "both" }}
    >
      {/* Section header */}
      <div className="flex items-center gap-3 mb-4">
        <div className={`flex items-center justify-center w-9 h-9 rounded-lg ${accent}`}>
          <Icon className="w-[18px] h-[18px]" />
        </div>
        <h2 className="text-lg font-semibold">{category.name}</h2>
        <span className="text-xs text-muted-foreground ml-auto tabular-nums">
          {enabled > 0 ? `${enabled} / ${total} active` : `${total} sources`}
        </span>
      </div>

      {/* Collector grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {category.collectors.map((collector, i) => (
          <CollectorCard
            key={collector.id}
            collector={collector}
            categoryId={category.id}
            delay={index * 60 + (i + 1) * 40}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Collector Card
// ---------------------------------------------------------------------------

function CollectorCard({
  collector,
  categoryId,
  delay,
}: {
  collector: Collector;
  categoryId: string;
  delay: number;
}) {
  const Icon = getIcon(collector.icon);
  const status = dominantStatus(collector);
  const { label, className: statusClassName } = statusConfig[status];
  const { enabled, total } = countCollectorEnabled(collector);
  const accent = categoryAccent[categoryId] ?? "bg-muted text-muted-foreground";

  return (
    <Link
      to={`/data-collectors/${collector.id}`}
      className="group animate-slide-up-fade"
      style={{ animationDelay: `${delay}ms`, animationFillMode: "both" }}
    >
      <div className="bg-card border rounded-xl p-4 h-full flex items-start gap-3 transition-all duration-200 group-hover:shadow-md group-hover:border-foreground/15 group-hover:-translate-y-0.5">
        {/* Icon */}
        <div className={`flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-lg ${accent} transition-transform duration-200 group-hover:scale-105`}>
          <Icon className="w-5 h-5" />
        </div>

        {/* Text */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{collector.name}</span>
            {enabled > 0 && (
              <span className="flex-shrink-0 text-[10px] font-medium tabular-nums bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400 px-1.5 py-0.5 rounded-full">
                {enabled}/{total}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
            {collector.description}
          </p>
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusDot[status]}`} />
            <span className={`text-[11px] ${statusClassName}`}>{label}</span>
          </div>
        </div>

        {/* Chevron */}
        <ChevronRight className="w-4 h-4 text-muted-foreground/50 flex-shrink-0 mt-0.5 transition-transform duration-200 group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
