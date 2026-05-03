import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react";

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

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen p-8 text-center">
        <div>
          <h1 className="text-3xl font-bold mb-4">{t("apps.title", "Import from apps")}</h1>
          <p className="text-muted-foreground">
            {t("page.signInHint", "Please sign in to get started.")}
          </p>
        </div>
      </div>
    );
  }

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
