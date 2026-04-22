import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react";

import { useApps } from "~/hooks/use-apps";
import { useAuth } from "~/contexts/auth-context";
import type { App } from "~/types/apps";
import { AppIconTile } from "~/components/apps/app-icon-tile";
import { AppImportDialog } from "~/components/apps/app-import-dialog";

export default function DataAppsPage() {
  const { t } = useTranslation("data");
  const { isAuthenticated, isLoading } = useAuth();
  const { data: apps, isLoading: appsLoading, error } = useApps();
  const [selected, setSelected] = useState<App | null>(null);

  if (isLoading) return null;

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen p-8 text-center">
        <div>
          <h1 className="text-3xl font-bold mb-4">{t("apps.title", "Apps")}</h1>
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
          {t("apps.title", "Apps")}
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
          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-4 sm:gap-6 p-6">
            {apps.map((app) => (
              <button
                key={app.id}
                type="button"
                onClick={() => setSelected(app)}
                className="flex flex-col items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-2xl"
                title={app.description}
              >
                <AppIconTile app={app} size="lg" />
                <span className="text-xs font-medium text-foreground truncate max-w-full">
                  {app.name}
                </span>
              </button>
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
