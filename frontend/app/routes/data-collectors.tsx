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

const categoryAccent: Record<string, string> = {
  time: "bg-blue-500",
  health: "bg-emerald-500",
  diet: "bg-amber-500",
  communication: "bg-violet-500",
  content: "bg-rose-500",
};

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
    <div className="w-full px-4 py-6 md:px-[10%] space-y-10 pb-20">
      {categories.map((cat, catIdx) => {
        const activeColor = categoryAccent[cat.id] ?? "bg-muted-foreground";

        return (
          <section
            key={cat.id}
            className="animate-slide-up-fade"
            style={{ animationDelay: `${catIdx * 50}ms`, animationFillMode: "both" }}
          >
            <h2 className="text-sm font-medium text-muted-foreground mb-3">{cat.name}</h2>

            <div className="grid grid-cols-4 sm:grid-cols-5 lg:grid-cols-7 gap-2">
              {cat.collectors.map((collector) => (
                <CollectorTile
                  key={collector.id}
                  collector={collector}
                  activeColor={activeColor}
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
        aspect-square rounded-xl flex flex-col items-center justify-center gap-2.5 relative
        transition-all duration-150 border
        ${isActive
          ? "bg-card border-foreground/10"
          : "bg-transparent border-transparent"
        }
        group-hover:bg-card group-hover:border-foreground/10 group-hover:shadow-sm
      `}>
        <Icon className={`w-5 h-5 ${isActive ? "text-foreground" : "text-muted-foreground/60"}`} />
        <span className={`text-[11px] text-center leading-tight px-1 ${isActive ? "font-medium" : "text-muted-foreground/80"}`}>
          {collector.name}
        </span>
        {isActive && (
          <span className={`absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full ${activeColor}`} />
        )}
      </div>
    </Link>
  );
}
