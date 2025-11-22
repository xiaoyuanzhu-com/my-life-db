'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sparkles, Save, Check, Loader2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useSettingsContext } from '../_context/settings-context';
import { SettingsHeader } from '../_components/settings-header';
import { TasksTab } from '../_components/tasks-tab';
import type { UserSettings } from '@/lib/config/settings';

interface ModelOption {
  id: string;
  owned_by?: string;
}

interface DigestStats {
  totalFiles: number;
  digestedFiles: number;
  pendingDigests: number;
}

export default function SettingsPage() {
  const params = useParams();
  const { settings, setSettings, isLoading, isSaving, saveMessage, saveSettings } = useSettingsContext();
  const [isModelModalOpen, setIsModelModalOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [digestStats, setDigestStats] = useState<DigestStats | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState(false);

  const filteredModels = useMemo(() => {
    if (!modelQuery) return modelOptions;
    const query = modelQuery.toLowerCase();
    return modelOptions.filter((model) => {
      const matchesId = model.id.toLowerCase().includes(query);
      const matchesOwner = model.owned_by?.toLowerCase().includes(query) ?? false;
      return matchesId || matchesOwner;
    });
  }, [modelOptions, modelQuery]);

  const fetchModels = useCallback(async () => {
    setModelError(null);
    setIsModelLoading(true);

    try {
      const response = await fetch('/api/vendors/openai/models');
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error || 'Failed to fetch models';
        throw new Error(message);
      }

      setModelOptions(Array.isArray(payload?.models) ? payload.models : []);
    } catch (error) {
      setModelOptions([]);
      setModelError(error instanceof Error ? error.message : 'Failed to fetch models');
    } finally {
      setIsModelLoading(false);
    }
  }, []);

  const handleOpenModelSelector = useCallback(() => {
    setModelQuery('');
    setIsModelModalOpen(true);
    void fetchModels();
  }, [fetchModels]);

  const handleModelSelect = useCallback(
    (modelId: string) => {
      if (!settings) return;
      setSettings({
        ...settings,
        vendors: {
          ...settings.vendors,
          openai: {
            ...settings.vendors?.openai,
            model: modelId,
          },
        },
      });
      setIsModelModalOpen(false);
    },
    [setSettings, settings]
  );

  const fetchDigestStats = useCallback(async () => {
    setIsLoadingStats(true);
    try {
      const response = await fetch('/api/digest/stats');
      if (response.ok) {
        const data = await response.json();
        setDigestStats(data);
      }
    } catch (error) {
      console.error('Failed to fetch digest stats:', error);
    } finally {
      setIsLoadingStats(false);
    }
  }, []);


  // Determine active tab from URL
  const tabParam = params.tab as string[] | undefined;
  const activeTab = tabParam?.[0] || 'general';

  // Fetch digest stats when digesters tab is active
  useEffect(() => {
    if (activeTab === 'digesters') {
      void fetchDigestStats();
    }
  }, [activeTab, fetchDigestStats]);

  if (isLoading) {
    return (
      <div className="px-[20%] py-12">
        <div className="text-center">Loading settings...</div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="px-[20%] py-12">
        <div className="text-center text-destructive">Failed to load settings</div>
      </div>
    );
  }

  const handleSave = () => {
    // Save only the relevant settings based on active tab
    if (activeTab === 'general') {
      saveSettings({ preferences: settings.preferences });
    } else if (activeTab === 'vendors') {
      saveSettings({ vendors: settings.vendors });
    } else if (activeTab === 'digesters') {
      saveSettings({ digesters: settings.digesters });
    }
    // Tasks tab doesn't need saving - it's read-only
  };

  const tabs = [
    { label: 'General', value: 'general', path: '/settings' },
    { label: 'Vendors', value: 'vendors', path: '/settings/vendors' },
    { label: 'Digest', value: 'digesters', path: '/settings/digesters' },
    { label: 'Tasks', value: 'tasks', path: '/settings/tasks' },
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
              href={tab.path}
              className={`inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                activeTab === tab.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'hover:bg-background/50'
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </div>

        {/* General Tab */}
        {activeTab === 'general' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5" />
                General Settings
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-2">
                Configure application-wide preferences
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <label className="text-sm font-medium">User Email</label>
                <Input
                  type="email"
                  placeholder="user@example.com"
                  value={settings.preferences?.userEmail || ''}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      preferences: {
                        ...(settings.preferences || { theme: 'auto', defaultView: 'home', weeklyDigest: false, digestDay: 0 }),
                        userEmail: e.target.value,
                      } as UserSettings['preferences'],
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">Used for displaying your Gravatar avatar in the header.</p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Log Level</label>
                <select
                  className="w-full px-3 py-2 rounded-md border bg-background"
                  value={settings.preferences?.logLevel || 'info'}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      preferences: ({
                        ...(settings.preferences || { theme: 'auto', defaultView: 'home', weeklyDigest: false, digestDay: 0 }),
                        logLevel: e.target.value as 'debug' | 'info' | 'warn' | 'error',
                      }) as UserSettings['preferences'],
                    })
                  }
                >
                  <option value="debug">debug</option>
                  <option value="info">info</option>
                  <option value="warn">warn</option>
                  <option value="error">error</option>
                </select>
                <p className="text-xs text-muted-foreground">A browser refresh or server restart may be required to apply.</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Vendors Tab */}
        {activeTab === 'vendors' && (
          <Card>
            <CardHeader>
              <CardTitle>Vendor Configuration</CardTitle>
              <p className="text-sm text-muted-foreground mt-2">
                Configure third-party vendor endpoints and credentials
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">OpenAI - Base URL</label>
                <Input
                  placeholder="https://api.openai.com/v1"
                  value={settings.vendors?.openai?.baseUrl || ''}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      vendors: {
                        ...settings.vendors,
                        openai: { ...settings.vendors?.openai, baseUrl: e.target.value },
                      },
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">OpenAI - API Key</label>
                <Input
                  type="password"
                  placeholder="sk-..."
                  value={settings.vendors?.openai?.apiKey || ''}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      vendors: {
                        ...settings.vendors,
                        openai: { ...settings.vendors?.openai, apiKey: e.target.value },
                      },
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">OpenAI - Model</label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOpenModelSelector}
                    disabled={isModelLoading}
                  >
                    {isModelLoading ? 'Loading...' : 'Select Model'}
                  </Button>
                </div>
                <Input
                  placeholder="gpt-4o"
                  value={settings.vendors?.openai?.model || ''}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      vendors: {
                        ...settings.vendors,
                        openai: { ...settings.vendors?.openai, model: e.target.value },
                      },
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">Used for all LLM tasks. Leave blank to use default.</p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Homelab AI - Base URL</label>
                <Input
                  placeholder="https://haid.home.iloahz.com"
                  value={settings.vendors?.homelabAi?.baseUrl || ''}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      vendors: {
                        ...settings.vendors,
                        homelabAi: { ...settings.vendors?.homelabAi, baseUrl: e.target.value },
                      },
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Homelab AI - Remote Chrome CDP</label>
                <Input
                  placeholder="ws://remote-chrome:9222"
                  value={settings.vendors?.homelabAi?.chromeCdpUrl || ''}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      vendors: {
                        ...settings.vendors,
                        homelabAi: {
                          ...settings.vendors?.homelabAi,
                          chromeCdpUrl: e.target.value,
                        },
                      },
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Search - Meilisearch Host</label>
                <Input
                  placeholder="http://localhost:7700"
                  value={settings.vendors?.meilisearch?.host || ''}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      vendors: {
                        ...settings.vendors,
                        meilisearch: {
                          ...settings.vendors?.meilisearch,
                          host: e.target.value,
                        },
                      },
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Used by the search API to connect to your local Meilisearch instance.
                </p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Search - Qdrant Host</label>
                <Input
                  placeholder="http://localhost:6333"
                  value={settings.vendors?.qdrant?.host || ''}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      vendors: {
                        ...settings.vendors,
                        qdrant: {
                          ...settings.vendors?.qdrant,
                          host: e.target.value,
                        },
                      },
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Base URL for the Qdrant vector service used by semantic search.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Digesters Tab */}
        {activeTab === 'digesters' && (
          <Card>
            <CardHeader>
              <CardTitle>Digester Configuration</CardTitle>
              <p className="text-sm text-muted-foreground mt-2">
                Enable or disable individual digesters for file processing
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Stats Display */}
              <div className="flex items-center justify-between p-4 rounded-lg border bg-muted/50">
                <div className="flex items-center gap-8">
                  {isLoadingStats ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <>
                      <div className="space-y-1">
                        <div className="text-2xl font-semibold">
                          {digestStats?.digestedFiles ?? 0}
                        </div>
                        <div className="text-xs text-muted-foreground">Digested Files</div>
                      </div>
                      <div className="h-8 w-px bg-border" />
                      <div className="space-y-1">
                        <div className="text-2xl font-semibold">
                          {digestStats?.totalFiles ?? 0}
                        </div>
                        <div className="text-xs text-muted-foreground">Total Files</div>
                      </div>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {!isLoadingStats && digestStats && (
                    <>
                      {digestStats.pendingDigests > 0 ? (
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-2 rounded-full bg-yellow-500 animate-pulse" />
                          <span className="text-sm text-muted-foreground">Processing</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-2 rounded-full bg-green-500" />
                          <span className="text-sm text-muted-foreground">Up to date</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Digester Toggles */}
              <div className="space-y-4">
              {[
                {
                  key: 'url-crawler',
                  label: 'URL Crawler',
                  description: 'Crawl URLs and extract content, screenshots, and metadata'
                },
                {
                  key: 'url-crawl-summary',
                  label: 'URL Crawl Summary',
                  description: 'Generate AI summaries of crawled URL content'
                },
                {
                  key: 'tags',
                  label: 'Tags',
                  description: 'Extract and generate tags for content organization'
                },
                {
                  key: 'slug',
                  label: 'Slug',
                  description: 'Generate friendly slugs for file naming'
                },
                {
                  key: 'search-keyword',
                  label: 'Search Keyword',
                  description: 'Index content for keyword search (Meilisearch)'
                },
                {
                  key: 'search-semantic',
                  label: 'Search Semantic',
                  description: 'Generate embeddings for semantic search (Qdrant)'
                },
              ].map(({ key, label, description }) => (
                <div key={key} className="flex items-center justify-between py-2">
                  <div className="space-y-0.5">
                    <div className="text-sm font-medium">{label}</div>
                    <p className="text-xs text-muted-foreground">{description}</p>
                  </div>
                  <button
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      (settings.digesters?.[key as keyof typeof settings.digesters] ?? true) === true
                        ? 'bg-primary'
                        : 'bg-muted'
                    }`}
                    onClick={() => {
                      const currentValue = settings.digesters?.[key as keyof typeof settings.digesters] ?? true;
                      setSettings({
                        ...settings,
                        digesters: {
                          ...settings.digesters,
                          [key]: !currentValue,
                        },
                      });
                    }}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        (settings.digesters?.[key as keyof typeof settings.digesters] ?? true) === true
                          ? 'translate-x-6'
                          : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tasks Tab */}
        {activeTab === 'tasks' && <TasksTab />}

        {/* Save Button - Only show for tabs that have settings to save */}
        {activeTab !== 'tasks' && (
          <div className="flex items-center justify-end gap-3 pt-6">
            {saveMessage && (
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-600" />
                <span
                  className={`text-sm ${
                    saveMessage.includes('Error') ? 'text-destructive' : 'text-green-600'
                  }`}
                >
                  {saveMessage}
                </span>
              </div>
            )}
            <Button onClick={handleSave} disabled={isSaving} className="gap-2">
              <Save className="h-4 w-4" />
              {isSaving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        )}
      </div>
      {isModelModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={() => setIsModelModalOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-lg bg-background p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold">Select OpenAI Model</h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsModelModalOpen(false)}
              >
                Close
              </Button>
            </div>
            <div className="space-y-3">
              <Input
                placeholder="Filter models..."
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
              />
              {modelError && (
                <div className="space-y-2">
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {modelError}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void fetchModels()}
                    disabled={isModelLoading}
                  >
                    Retry
                  </Button>
                </div>
              )}
              {isModelLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {filteredModels.map((model) => {
                    const isSelected = settings?.vendors?.openai?.model === model.id;
                    return (
                      <button
                        key={model.id}
                        className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                          isSelected
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:bg-muted'
                        }`}
                        onClick={() => handleModelSelect(model.id)}
                      >
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{model.id}</span>
                          {model.owned_by && (
                            <span className="text-xs text-muted-foreground">
                              Owner: {model.owned_by}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                  {filteredModels.length === 0 && !modelError && (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      No models found. Check your API key permissions.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
