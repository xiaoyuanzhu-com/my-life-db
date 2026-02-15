import { useState, useEffect, type ComponentType } from "react";
import { Link } from "react-router";
import {
  Clock, Heart, UtensilsCrossed, MessageCircle, BookOpen,
  Monitor, Calendar, Target, Footprints, HeartPulse, Moon,
  Scale, Brain, Dumbbell, Droplets, Coffee, Utensils, Pill,
  MessageSquare, Mail, Phone, Share2, FileText, Play,
  Headphones, Bot, Music, Terminal, Camera,
} from "lucide-react";
import { useAuth } from "~/contexts/auth-context";
import {
  categories,
  countCollectorEnabled,
  type Collector,
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

const categoryAccent: Record<string, { icon: string; active: string }> = {
  time:          { icon: "text-blue-600 dark:text-blue-400",    active: "bg-blue-500" },
  health:        { icon: "text-emerald-600 dark:text-emerald-400", active: "bg-emerald-500" },
  diet:          { icon: "text-amber-600 dark:text-amber-400",  active: "bg-amber-500" },
  communication: { icon: "text-violet-600 dark:text-violet-400", active: "bg-violet-500" },
  content:       { icon: "text-rose-600 dark:text-rose-400",    active: "bg-rose-500" },
};

const defaultAccent = { icon: "text-muted-foreground", active: "bg-muted-foreground" };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DataCollectorsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [_, setTick] = useState(0);

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
    <div className="w-full px-4 py-8 md:px-[10%] space-y-10 pb-20">
      <h1 className="text-3xl font-bold tracking-tight">Data Collectors</h1>

      {categories.map((cat, catIdx) => {
        const CatIcon = getIcon(cat.icon);
        const accent = categoryAccent[cat.id] ?? defaultAccent;

        return (
          <section
            key={cat.id}
            className="animate-slide-up-fade"
            style={{ animationDelay: `${catIdx * 50}ms`, animationFillMode: "both" }}
          >
            <div className="flex items-center gap-2.5 mb-3">
              <CatIcon className={`w-5 h-5 ${accent.icon}`} />
              <h2 className="text-base font-semibold">{cat.name}</h2>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {cat.collectors.map((collector) => (
                <CollectorTile
                  key={collector.id}
                  collector={collector}
                  activeColor={accent.active}
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
// Tile
// ---------------------------------------------------------------------------

function CollectorTile({ collector, activeColor }: { collector: Collector; activeColor: string }) {
  const Icon = getIcon(collector.icon);
  const { enabled } = countCollectorEnabled(collector);
  const isActive = enabled > 0;

  return (
    <Link
      to={`/data-collectors/${collector.id}`}
      className="group"
    >
      <div className={`
        rounded-xl px-3 py-2.5 flex items-center gap-2.5
        transition-all duration-150
        border
        ${isActive
          ? "bg-card border-foreground/10"
          : "bg-transparent border-transparent"
        }
        group-hover:bg-card group-hover:border-foreground/10 group-hover:shadow-sm
      `}>
        <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? "text-foreground" : "text-muted-foreground"}`} />
        <span className={`text-sm truncate ${isActive ? "font-medium" : "text-muted-foreground"}`}>
          {collector.name}
        </span>
        {isActive && (
          <span className={`ml-auto w-1.5 h-1.5 rounded-full flex-shrink-0 ${activeColor}`} />
        )}
      </div>
    </Link>
  );
}
