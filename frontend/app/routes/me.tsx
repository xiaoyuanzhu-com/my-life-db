import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFormatter } from "~/lib/i18n/use-formatter";
import { useParams, Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Sparkles, Save, Check, Loader2 } from "lucide-react";
import { useSettingsContext } from "~/components/settings/settings-context";
import { UiLanguageSelector } from "~/components/settings/ui-language-selector";
import { useAuth } from "~/contexts/auth-context";
import type { UserSettings } from "~/lib/config/settings";
import { api } from "~/lib/api";
import { ConnectedAppsTab } from "~/components/settings/connected-apps-tab";

interface Stats {
  library: {
    fileCount: number;
    totalSize: number;
  };
}

function SettingsHeader() {
  const { t } = useTranslation('settings');
  return (
    <div>
      <h1 className="text-3xl font-bold">{t('page.title', 'Me')}</h1>
    </div>
  );
}

function SettingsContent() {
  const { t } = useTranslation('settings');
  const fmt = useFormatter();
  const params = useParams();

  // Determine active tab from URL first
  const tabParam = params["*"];
  const activeTab = tabParam || "general";

  const { settings, setSettings, isLoading, isSaving, saveMessage, saveSettings } = useSettingsContext();
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoadingGeneralStats, setIsLoadingGeneralStats] = useState(false);

  const fetchGeneralStats = useCallback(async (showLoading = true) => {
    if (showLoading) {
      setIsLoadingGeneralStats(true);
    }
    try {
      const response = await api.get("/api/system/stats");
      if (response.ok) {
        const data = await response.json();
        setStats(data);
      }
    } catch (error) {
      console.error("Failed to fetch stats:", error);
    } finally {
      if (showLoading) {
        setIsLoadingGeneralStats(false);
      }
    }
  }, []);

  // Fetch general stats when stats tab is active and refresh every 5 seconds
  useEffect(() => {
    if (activeTab === "stats") {
      void fetchGeneralStats(true);

      const intervalId = setInterval(() => {
        void fetchGeneralStats(false);
      }, 5000);

      return () => clearInterval(intervalId);
    }
  }, [activeTab, fetchGeneralStats]);

  if (isLoading) {
    return (
      <div className="px-[20%] py-12">
        <div className="text-center">{t('page.loading', 'Loading settings...')}</div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="px-[20%] py-12">
        <div className="text-center text-destructive">{t('page.loadFailed', 'Failed to load settings')}</div>
      </div>
    );
  }

  const handleSave = () => {
    if (activeTab === "general") {
      saveSettings({ preferences: settings.preferences });
    }
  };

  const tabs = [
    { label: t('tabs.general', 'General'), value: "general", path: "/me" },
    { label: t('tabs.connectedApps', 'Connected Apps'), value: "connected-apps", path: "/me/connected-apps" },
    { label: t('tabs.stats', 'Stats'), value: "stats", path: "/me/stats" },
  ];

  return (
    <div className="px-[20%] py-12 mb-20 md:mb-0">
      <div className="space-y-6">
        <SettingsHeader />

        {/* Tab Navigation */}
        <div className="inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground">
          {tabs.map((tab) => (
            <Link
              key={tab.value}
              to={tab.path}
              className={`inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                activeTab === tab.value ? "bg-background text-foreground shadow-sm" : "hover:bg-background/50"
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </div>

        {/* General Tab */}
        {activeTab === "general" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5" />
                {t('general.title', 'General Settings')}
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-2">{t('general.subtitle', 'Configure application-wide preferences')}</p>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('general.uiLanguage.label', 'Display language')}</label>
                <UiLanguageSelector
                  value={settings.preferences?.language}
                  onChange={(lang) =>
                    setSettings({
                      ...settings,
                      preferences: {
                        ...(settings.preferences || {
                          theme: "auto",
                          defaultView: "home",
                        }),
                        language: lang,
                      } as UserSettings["preferences"],
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {t('general.uiLanguage.hint', "The language used for MyLifeDB's interface. Empty follows your browser/system.")}
                </p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('general.logLevel.label', 'Log Level')}</label>
                <select
                  className="w-full px-3 py-2 rounded-md border bg-background"
                  value={settings.preferences?.logLevel || "info"}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      preferences: {
                        ...(settings.preferences || {
                          theme: "auto",
                          defaultView: "home",
                        }),
                        logLevel: e.target.value as "debug" | "info" | "warn" | "error",
                      } as UserSettings["preferences"],
                    })
                  }
                >
                  <option value="debug">debug</option>
                  <option value="info">info</option>
                  <option value="warn">warn</option>
                  <option value="error">error</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  {t('general.logLevel.hint', 'A browser refresh or server restart may be required to apply.')}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stats Tab */}
        {activeTab === "stats" && (
          <Card>
            <CardContent className="space-y-6">
              {isLoadingGeneralStats ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : stats ? (
                <div className="space-y-6">
                  {/* Library Stats */}
                  <div>
                    <h3 className="text-sm font-medium mb-3">{t('stats.library', 'Library')}</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-4 rounded-lg border bg-muted/50">
                        <div className="text-2xl font-semibold">{fmt.number(stats.library.fileCount)}</div>
                        <div className="text-xs text-muted-foreground mt-1">{t('stats.files', 'Files')}</div>
                      </div>
                      <div className="p-4 rounded-lg border bg-muted/50">
                        <div className="text-2xl font-semibold">
                          {fmt.fileSize(stats.library.totalSize)}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">{t('stats.totalSize', 'Total Size')}</div>
                      </div>
                    </div>
                  </div>

                </div>
              ) : (
                <div className="text-center text-muted-foreground py-8">{t('stats.loadFailed', 'Failed to load statistics')}</div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Connected Apps Tab */}
        {activeTab === "connected-apps" && (
          <ConnectedAppsTab />
        )}

        {/* Save Button */}
        {activeTab !== "stats" && activeTab !== "connected-apps" && (
          <div className="flex items-center justify-end gap-3 pt-6">
            {saveMessage && (
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-600" />
                <span className={`text-sm ${saveMessage.includes("Error") ? "text-destructive" : "text-green-600"}`}>
                  {saveMessage}
                </span>
              </div>
            )}
            <Button onClick={handleSave} disabled={isSaving} className="gap-2">
              <Save className="h-4 w-4" />
              {isSaving ? t('actions.saving', 'Saving...') : t('actions.save', 'Save Settings')}
            </Button>
          </div>
        )}
      </div>

    </div>
  );
}

export default function MePage() {
  const { t } = useTranslation('settings');
  const { isAuthenticated, isLoading } = useAuth();

  // Show loading state while checking authentication
  if (isLoading) {
    return null;
  }

  // Show welcome page when not authenticated
  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen p-8 text-center">
        <div>
          <h1 className="text-3xl font-bold mb-4">{t('page.title', 'Me')}</h1>
          <p className="text-muted-foreground text-lg mb-8 max-w-2xl">
            {t('page.unauthDescription', 'Configure your preferences and system settings.')}
          </p>
          <p className="text-muted-foreground">
            {t('page.unauthSignInHint', 'Please sign in using the button in the header to get started.')}
          </p>
        </div>
      </div>
    );
  }

  return <SettingsContent />;
}
