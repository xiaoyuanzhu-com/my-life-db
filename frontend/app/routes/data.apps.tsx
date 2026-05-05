import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronLeft, Sparkles } from "lucide-react";

import { useApps } from "~/hooks/use-apps";
import { useAuth } from "~/contexts/auth-context";
import type { App } from "~/types/apps";
import { AppIconTile } from "~/components/apps/app-icon-tile";
import { AppImportDialog } from "~/components/apps/app-import-dialog";
import { groupAppsIntoSections } from "~/lib/app-sections";

export default function DataAppsPage() {
  const { t } = useTranslation("data");
  const { isAuthenticated, isLoading } = useAuth();
  const { data: apps, isLoading: appsLoading, error } = useApps();
  const [selected, setSelected] = useState<App | null>(null);

  const sections = useMemo(() => (apps ? groupAppsIntoSections(apps) : []), [apps]);

  if (isLoading) return null;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Top bar — same chrome as Data, sub-page breadcrumb */}
      <div className="shrink-0 px-4 py-3 flex items-center gap-2 md:px-[10%]">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          {t("apps.back", "Data")}
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium">
          {t("apps.title", "Import from apps")}
        </span>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto md:px-[10%]">
        <section className="px-6 pt-6 pb-2">
          <div className="relative overflow-hidden rounded-3xl border border-border bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.18),transparent_38%),linear-gradient(135deg,hsl(var(--card)),hsl(var(--muted)))] px-6 py-8 shadow-sm sm:px-8">
            <div className="relative z-10 max-w-3xl">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground ring-1 ring-border backdrop-blur">
                <Sparkles className="h-3.5 w-3.5" />
                {t("apps.hero.kicker", "Start with data you already have")}
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
                {t("apps.hero.title", "Turn your apps into a private AI memory.")}
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                {t(
                  "apps.hero.description",
                  "Pick an app, choose an import path, and preview the exact agent prompt before creating your own MyLifeDB space.",
                )}
              </p>
              {!isAuthenticated && (
                <p className="mt-4 text-xs font-medium text-muted-foreground">
                  {t("apps.hero.signInLater", "No account needed to browse. You only sign in when you run an import.")}
                </p>
              )}
            </div>
            <div className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full bg-cyan-400/20 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-20 right-20 h-56 w-56 rounded-full bg-emerald-400/10 blur-3xl" />
          </div>
        </section>

        {appsLoading && (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        )}
        {error && (
          <div className="p-6 text-sm text-destructive">
            Failed to load apps
          </div>
        )}
        {apps && apps.length === 0 && (
          <div className="p-6 text-sm text-muted-foreground">
            No apps registered.
          </div>
        )}
        {apps && apps.length > 0 && (
          <div className="p-6 flex flex-col gap-8">
            {sections.map((section) => (
              <section key={section.key} className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  {t(`apps.sections.${section.key}`, section.key)}
                </h2>
                <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-4 sm:gap-6">
                  {section.apps.map((app) => {
                    const name = t(`apps.names.${app.id}`, app.name);
                    return (
                      <button
                        key={`${section.key}-${app.id}`}
                        type="button"
                        onClick={() => setSelected(app)}
                        className="flex flex-col items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-2xl"
                        title={app.description}
                      >
                        <AppIconTile app={app} name={name} />
                        <span className="text-xs font-medium text-foreground truncate max-w-full">
                          {name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <AppImportDialog
        app={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </div>
  );
}
