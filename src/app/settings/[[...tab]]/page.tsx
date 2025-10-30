'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sparkles, Save, Check } from 'lucide-react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useSettingsContext } from '../_context/SettingsContext';
import { SettingsHeader } from '../_components/SettingsHeader';
import { TasksTab } from '../_components/TasksTab';
import type { UserSettings } from '@/lib/config/settings';

export default function SettingsPage() {
  const params = useParams();
  const { settings, setSettings, isLoading, isSaving, saveMessage, saveSettings } = useSettingsContext();

  // Determine active tab from URL
  const tabParam = params.tab as string[] | undefined;
  const activeTab = tabParam?.[0] || 'general';

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
      saveSettings({ ai: settings.ai });
    } else if (activeTab === 'enrichment') {
      saveSettings({ enrichment: settings.enrichment });
    } else if (activeTab === 'vendors') {
      saveSettings({ vendors: settings.vendors });
    }
    // Tasks tab doesn't need saving - it's read-only
  };

  const tabs = [
    { label: 'General', value: 'general', path: '/settings' },
    { label: 'Enrichment', value: 'enrichment', path: '/settings/enrichment' },
    { label: 'Vendors', value: 'vendors', path: '/settings/vendors' },
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
                AI Provider
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-2">
                Choose your AI provider for information extraction
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <label className="text-sm font-medium">Provider</label>
                <select
                  className="w-full px-3 py-2 rounded-md border bg-background"
                  value={settings.ai?.provider || 'none'}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      ai: { ...settings.ai, provider: e.target.value as 'openai' | 'ollama' | 'custom' | 'none' },
                    })
                  }
                >
                  <option value="none">None (Rule-based only)</option>
                  <option value="openai">OpenAI</option>
                  <option value="ollama">Ollama (Local)</option>
                  <option value="custom">Custom API</option>
                </select>
              </div>

              {/* OpenAI Configuration */}
              {settings.ai?.provider === 'openai' && (
                <div className="space-y-4 pt-4 border-t">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">OpenAI API Key</label>
                    <Input
                      type="password"
                      placeholder="sk-..."
                      value={settings.ai?.openai?.apiKey || ''}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          ai: {
                            ...settings.ai,
                            openai: { ...settings.ai?.openai, apiKey: e.target.value },
                          } as UserSettings['ai'],
                        })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Get your API key from{' '}
                      <a
                        href="https://platform.openai.com/api-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        OpenAI Dashboard
                      </a>
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Base URL (Optional)</label>
                    <Input
                      placeholder="https://api.openai.com/v1"
                      value={settings.ai?.openai?.baseUrl || ''}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          ai: {
                            ...settings.ai,
                            openai: { ...settings.ai?.openai, baseUrl: e.target.value },
                          } as UserSettings['ai'],
                        })
                      }
                    />
                    <p className="text-xs text-muted-foreground">Leave empty for default</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Model</label>
                    <Input
                      placeholder="gpt-4"
                      value={settings.ai?.openai?.model || ''}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          ai: {
                            ...settings.ai,
                            openai: { ...settings.ai?.openai, model: e.target.value },
                          } as UserSettings['ai'],
                        })
                      }
                    />
                  </div>
                </div>
              )}

              {/* Ollama Configuration */}
              {settings.ai?.provider === 'ollama' && (
                <div className="space-y-4 pt-4 border-t">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Ollama Base URL</label>
                    <Input
                      placeholder="http://localhost:11434"
                      value={settings.ai?.ollama?.baseUrl || ''}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          ai: {
                            ...settings.ai,
                            ollama: { ...settings.ai?.ollama, baseUrl: e.target.value },
                          } as UserSettings['ai'],
                        })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Model</label>
                    <Input
                      placeholder="llama2"
                      value={settings.ai?.ollama?.model || ''}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          ai: {
                            ...settings.ai,
                            ollama: { ...settings.ai?.ollama, model: e.target.value },
                          } as UserSettings['ai'],
                        })
                      }
                    />
                  </div>
                </div>
              )}

              {/* Custom API Configuration */}
              {settings.ai?.provider === 'custom' && (
                <div className="space-y-4 pt-4 border-t">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">API Base URL</label>
                    <Input
                      placeholder="https://your-api.com/v1"
                      value={settings.ai?.custom?.baseUrl || ''}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          ai: {
                            ...settings.ai,
                            custom: { ...settings.ai?.custom, baseUrl: e.target.value },
                          } as UserSettings['ai'],
                        })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">API Key (Optional)</label>
                    <Input
                      type="password"
                      placeholder="Your API key"
                      value={settings.ai?.custom?.apiKey || ''}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          ai: {
                            ...settings.ai,
                            custom: { ...settings.ai?.custom, apiKey: e.target.value },
                          } as UserSettings['ai'],
                        })
                      }
                    />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Enrichment Tab */}
        {activeTab === 'enrichment' && (
          <Card>
            <CardHeader>
              <CardTitle>Enrichment Features</CardTitle>
              <p className="text-sm text-muted-foreground mt-2">
                Configure AI-powered enrichment by input type for quick capture and semantic search
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Text/Notes */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Text / Notes</h3>
                <div className="pl-4 space-y-2">
                  {[
                    { key: 'entityExtraction', label: 'Entity extraction (people, places, topics)', description: 'Find all notes mentioning specific entities' },
                    { key: 'autoTagging', label: 'Auto-tagging (key phrases)', description: 'Automatic organization without manual effort' },
                    { key: 'embeddings', label: 'Generate embeddings', description: 'Enable semantic search' },
                  ].map(({ key, label, description }) => (
                    <div key={key} className="flex items-center justify-between py-1">
                      <div className="space-y-0.5">
                        <div className="text-sm">{label}</div>
                        <p className="text-xs text-muted-foreground">{description}</p>
                      </div>
                      <button
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          (settings.enrichment?.text?.[key as keyof typeof settings.enrichment.text] ?? true) === true
                            ? 'bg-primary'
                            : 'bg-muted'
                        }`}
                        onClick={() => {
                          const currentValue = settings.enrichment?.text?.[key as keyof typeof settings.enrichment.text] ?? true;
                          setSettings({
                            ...settings,
                            enrichment: {
                              ...settings.enrichment,
                              text: {
                                ...settings.enrichment?.text,
                                [key]: !currentValue,
                              },
                            } as UserSettings['enrichment'],
                          });
                        }}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            (settings.enrichment?.text?.[key as keyof typeof settings.enrichment.text] ?? true) === true
                              ? 'translate-x-6'
                              : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* URL/Links */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">URL / Links</h3>
                <div className="pl-4 space-y-2">
                  {[
                    { key: 'contentCrawl', label: 'Crawl & extract main content', description: 'Full-text searchable articles' },
                    { key: 'screenshot', label: 'Screenshot capture', description: 'Visual memory + OCR' },
                    { key: 'metadataExtraction', label: 'Extract metadata', description: 'Title, description, author, date' },
                    { key: 'embeddings', label: 'Generate embeddings', description: 'Semantic search on article content' },
                  ].map(({ key, label, description }) => (
                    <div key={key} className="flex items-center justify-between py-1">
                      <div className="space-y-0.5">
                        <div className="text-sm">{label}</div>
                        <p className="text-xs text-muted-foreground">{description}</p>
                      </div>
                      <button
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          (settings.enrichment?.url?.[key as keyof typeof settings.enrichment.url] ?? true) === true
                            ? 'bg-primary'
                            : 'bg-muted'
                        }`}
                        onClick={() => {
                          const currentValue = settings.enrichment?.url?.[key as keyof typeof settings.enrichment.url] ?? true;
                          setSettings({
                            ...settings,
                            enrichment: {
                              ...settings.enrichment,
                              url: {
                                ...settings.enrichment?.url,
                                [key]: !currentValue,
                              },
                            } as UserSettings['enrichment'],
                          });
                        }}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            (settings.enrichment?.url?.[key as keyof typeof settings.enrichment.url] ?? true) === true
                              ? 'translate-x-6'
                              : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Images */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Images</h3>
                <div className="pl-4 space-y-2">
                  {[
                    { key: 'captioning', label: 'Image captioning', description: 'Search "find images with cats"' },
                    { key: 'ocr', label: 'OCR (text extraction)', description: 'Search text in screenshots/documents' },
                    { key: 'embeddings', label: 'Generate embeddings', description: 'Semantic search from caption + OCR' },
                  ].map(({ key, label, description }) => (
                    <div key={key} className="flex items-center justify-between py-1">
                      <div className="space-y-0.5">
                        <div className="text-sm">{label}</div>
                        <p className="text-xs text-muted-foreground">{description}</p>
                      </div>
                      <button
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          (settings.enrichment?.image?.[key as keyof typeof settings.enrichment.image] ?? true) === true
                            ? 'bg-primary'
                            : 'bg-muted'
                        }`}
                        onClick={() => {
                          const currentValue = settings.enrichment?.image?.[key as keyof typeof settings.enrichment.image] ?? true;
                          setSettings({
                            ...settings,
                            enrichment: {
                              ...settings.enrichment,
                              image: {
                                ...settings.enrichment?.image,
                                [key]: !currentValue,
                              },
                            } as UserSettings['enrichment'],
                          });
                        }}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            (settings.enrichment?.image?.[key as keyof typeof settings.enrichment.image] ?? true) === true
                              ? 'translate-x-6'
                              : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Audio */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Audio</h3>
                <div className="pl-4 space-y-2">
                  {[
                    { key: 'transcription', label: 'ASR (speech-to-text)', description: 'Full transcription' },
                    { key: 'speakerDiarization', label: 'Speaker diarization', description: 'Identify who said what' },
                    { key: 'timestampExtraction', label: 'Extract timestamps', description: 'Navigate by topic' },
                    { key: 'embeddings', label: 'Generate embeddings', description: 'Semantic search from transcript' },
                  ].map(({ key, label, description }) => (
                    <div key={key} className="flex items-center justify-between py-1">
                      <div className="space-y-0.5">
                        <div className="text-sm">{label}</div>
                        <p className="text-xs text-muted-foreground">{description}</p>
                      </div>
                      <button
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          (settings.enrichment?.audio?.[key as keyof typeof settings.enrichment.audio] ?? (key === 'speakerDiarization' ? false : true)) === true
                            ? 'bg-primary'
                            : 'bg-muted'
                        }`}
                        onClick={() => {
                          const currentValue = settings.enrichment?.audio?.[key as keyof typeof settings.enrichment.audio] ?? (key === 'speakerDiarization' ? false : true);
                          setSettings({
                            ...settings,
                            enrichment: {
                              ...settings.enrichment,
                              audio: {
                                ...settings.enrichment?.audio,
                                [key]: !currentValue,
                              },
                            } as UserSettings['enrichment'],
                          });
                        }}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            (settings.enrichment?.audio?.[key as keyof typeof settings.enrichment.audio] ?? (key === 'speakerDiarization' ? false : true)) === true
                              ? 'translate-x-6'
                              : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Video */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Video</h3>
                <div className="pl-4 space-y-2">
                  {[
                    { key: 'audioTranscription', label: 'Audio transcription (ASR)', description: 'Extract audio track and transcribe' },
                    { key: 'frameCaptioning', label: 'Frame captioning', description: 'Describe visual content' },
                    { key: 'embeddings', label: 'Generate embeddings', description: 'Semantic search from transcript + captions' },
                  ].map(({ key, label, description }) => (
                    <div key={key} className="flex items-center justify-between py-1">
                      <div className="space-y-0.5">
                        <div className="text-sm">{label}</div>
                        <p className="text-xs text-muted-foreground">{description}</p>
                      </div>
                      <button
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          (settings.enrichment?.video?.[key as keyof typeof settings.enrichment.video] ?? true) === true
                            ? 'bg-primary'
                            : 'bg-muted'
                        }`}
                        onClick={() => {
                          const currentValue = settings.enrichment?.video?.[key as keyof typeof settings.enrichment.video] ?? true;
                          setSettings({
                            ...settings,
                            enrichment: {
                              ...settings.enrichment,
                              video: {
                                ...settings.enrichment?.video,
                                [key]: !currentValue,
                              },
                            } as UserSettings['enrichment'],
                          });
                        }}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            (settings.enrichment?.video?.[key as keyof typeof settings.enrichment.video] ?? true) === true
                              ? 'translate-x-6'
                              : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* PDF/Documents */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">PDF / Documents</h3>
                <div className="pl-4 space-y-2">
                  {[
                    { key: 'textExtraction', label: 'Text extraction', description: 'Extract native text from PDFs' },
                    { key: 'ocr', label: 'OCR for scanned PDFs', description: 'Extract text from scanned documents' },
                    { key: 'metadataExtraction', label: 'Extract metadata', description: 'Title, author, dates' },
                    { key: 'embeddings', label: 'Generate embeddings', description: 'Semantic search' },
                  ].map(({ key, label, description }) => (
                    <div key={key} className="flex items-center justify-between py-1">
                      <div className="space-y-0.5">
                        <div className="text-sm">{label}</div>
                        <p className="text-xs text-muted-foreground">{description}</p>
                      </div>
                      <button
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          (settings.enrichment?.pdf?.[key as keyof typeof settings.enrichment.pdf] ?? true) === true
                            ? 'bg-primary'
                            : 'bg-muted'
                        }`}
                        onClick={() => {
                          const currentValue = settings.enrichment?.pdf?.[key as keyof typeof settings.enrichment.pdf] ?? true;
                          setSettings({
                            ...settings,
                            enrichment: {
                              ...settings.enrichment,
                              pdf: {
                                ...settings.enrichment?.pdf,
                                [key]: !currentValue,
                              },
                            } as UserSettings['enrichment'],
                          });
                        }}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            (settings.enrichment?.pdf?.[key as keyof typeof settings.enrichment.pdf] ?? true) === true
                              ? 'translate-x-6'
                              : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  ))}
                </div>
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
    </div>
  );
}
