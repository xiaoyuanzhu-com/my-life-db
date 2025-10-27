'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { UserSettings } from '@/lib/config/settings';
import { Sparkles, Save, Check } from 'lucide-react';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Partial<UserSettings> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const response = await fetch('/api/settings');
      const data = await response.json();
      setSettings(data);
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave() {
    if (!settings) return;

    setIsSaving(true);
    setSaveMessage(null);

    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      if (response.ok) {
        setSaveMessage('Settings saved successfully!');
        setTimeout(() => setSaveMessage(null), 3000);
      } else {
        const error = await response.json();
        setSaveMessage(`Error: ${error.error || 'Failed to save settings'}`);
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      setSaveMessage('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  }

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

  return (
    <div className="px-[20%] py-12 mb-20 md:mb-0">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Settings</h1>
          <p className="text-muted-foreground mt-2">
            Configure your MyLifeDB AI capabilities and extraction preferences
          </p>
        </div>

        {/* AI Configuration */}
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
                          },
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
                          },
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
                          },
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
                          },
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
                          },
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
                          },
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
                          },
                        })
                      }
                    />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

        {/* Vendor Configuration */}
        <Card>
          <CardHeader>
            <CardTitle>Vendor Configuration</CardTitle>
            <p className="text-sm text-muted-foreground mt-2">
              Configure third-party vendor endpoints and credentials
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">OpenAI - Base URL (OPENAI_BASE_URL)</label>
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
              <label className="text-sm font-medium">OpenAI - API Key (OPENAI_API_KEY)</label>
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
              <label className="text-sm font-medium">Homelab AI in Docker - Base URL</label>
              <Input
                placeholder="http://localhost:8080"
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

        {/* Processing Features */}
        <Card>
          <CardHeader>
            <CardTitle>Processing</CardTitle>
            <p className="text-sm text-muted-foreground mt-2">
              Configure AI-powered processing by input type for quick capture and semantic search
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
                        (settings.processing?.text?.[key as keyof typeof settings.processing.text] ?? true) === true
                          ? 'bg-primary'
                          : 'bg-muted'
                      }`}
                      onClick={() => {
                        const currentValue = settings.processing?.text?.[key as keyof typeof settings.processing.text] ?? true;
                        setSettings({
                          ...settings,
                          processing: {
                            ...settings.processing,
                            text: {
                              ...settings.processing?.text,
                              [key]: !currentValue,
                            },
                          },
                        });
                      }}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          (settings.processing?.text?.[key as keyof typeof settings.processing.text] ?? true) === true
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
                        (settings.processing?.url?.[key as keyof typeof settings.processing.url] ?? true) === true
                          ? 'bg-primary'
                          : 'bg-muted'
                      }`}
                      onClick={() => {
                        const currentValue = settings.processing?.url?.[key as keyof typeof settings.processing.url] ?? true;
                        setSettings({
                          ...settings,
                          processing: {
                            ...settings.processing,
                            url: {
                              ...settings.processing?.url,
                              [key]: !currentValue,
                            },
                          },
                        });
                      }}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          (settings.processing?.url?.[key as keyof typeof settings.processing.url] ?? true) === true
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
                        (settings.processing?.image?.[key as keyof typeof settings.processing.image] ?? true) === true
                          ? 'bg-primary'
                          : 'bg-muted'
                      }`}
                      onClick={() => {
                        const currentValue = settings.processing?.image?.[key as keyof typeof settings.processing.image] ?? true;
                        setSettings({
                          ...settings,
                          processing: {
                            ...settings.processing,
                            image: {
                              ...settings.processing?.image,
                              [key]: !currentValue,
                            },
                          },
                        });
                      }}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          (settings.processing?.image?.[key as keyof typeof settings.processing.image] ?? true) === true
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
                        (settings.processing?.audio?.[key as keyof typeof settings.processing.audio] ?? (key === 'speakerDiarization' ? false : true)) === true
                          ? 'bg-primary'
                          : 'bg-muted'
                      }`}
                      onClick={() => {
                        const currentValue = settings.processing?.audio?.[key as keyof typeof settings.processing.audio] ?? (key === 'speakerDiarization' ? false : true);
                        setSettings({
                          ...settings,
                          processing: {
                            ...settings.processing,
                            audio: {
                              ...settings.processing?.audio,
                              [key]: !currentValue,
                            },
                          },
                        });
                      }}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          (settings.processing?.audio?.[key as keyof typeof settings.processing.audio] ?? (key === 'speakerDiarization' ? false : true)) === true
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
                        (settings.processing?.video?.[key as keyof typeof settings.processing.video] ?? true) === true
                          ? 'bg-primary'
                          : 'bg-muted'
                      }`}
                      onClick={() => {
                        const currentValue = settings.processing?.video?.[key as keyof typeof settings.processing.video] ?? true;
                        setSettings({
                          ...settings,
                          processing: {
                            ...settings.processing,
                            video: {
                              ...settings.processing?.video,
                              [key]: !currentValue,
                            },
                          },
                        });
                      }}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          (settings.processing?.video?.[key as keyof typeof settings.processing.video] ?? true) === true
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
                        (settings.processing?.pdf?.[key as keyof typeof settings.processing.pdf] ?? true) === true
                          ? 'bg-primary'
                          : 'bg-muted'
                      }`}
                      onClick={() => {
                        const currentValue = settings.processing?.pdf?.[key as keyof typeof settings.processing.pdf] ?? true;
                        setSettings({
                          ...settings,
                          processing: {
                            ...settings.processing,
                            pdf: {
                              ...settings.processing?.pdf,
                              [key]: !currentValue,
                            },
                          },
                        });
                      }}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          (settings.processing?.pdf?.[key as keyof typeof settings.processing.pdf] ?? true) === true
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

        {/* Extraction Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Default Extraction Options</CardTitle>
            <p className="text-sm text-muted-foreground mt-2">
              Configure what information is extracted from your entries
            </p>
          </CardHeader>
            <CardContent className="space-y-4">
              {[
                { key: 'autoProcess', label: 'Auto-process new entries', description: 'Automatically extract information when creating entries' },
                { key: 'includeEntities', label: 'Extract entities (people, places, etc.)' },
                { key: 'includeSentiment', label: 'Analyze sentiment' },
                { key: 'includeActionItems', label: 'Extract action items' },
                { key: 'includeRelatedEntries', label: 'Find related entries' },
              ].map(({ key, label, description }) => (
                <div key={key} className="flex items-center justify-between py-2">
                  <div className="space-y-0.5">
                    <label className="text-sm font-medium cursor-pointer">
                      {label}
                    </label>
                    {description && (
                      <p className="text-xs text-muted-foreground">{description}</p>
                    )}
                  </div>
                  <button
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      settings.extraction?.[key as keyof typeof settings.extraction] !== false
                        ? 'bg-primary'
                        : 'bg-muted'
                    }`}
                    onClick={() =>
                      setSettings({
                        ...settings,
                        extraction: {
                          ...settings.extraction,
                          [key]: !settings.extraction?.[key as keyof typeof settings.extraction],
                        },
                      })
                    }
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        settings.extraction?.[key as keyof typeof settings.extraction] !== false
                          ? 'translate-x-6'
                          : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              ))}
            </CardContent>
          </Card>

        {/* Action Buttons */}
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
      </div>
    </div>
  );
}
