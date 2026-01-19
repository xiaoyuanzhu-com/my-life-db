import { useState, useEffect, useCallback } from 'react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { X, Loader2 } from 'lucide-react';
import { cleanupTranscript, formatDuration } from '~/lib/transcript-utils';

interface RecordingReviewModalProps {
  isOpen: boolean;
  rawTranscript: string;
  duration: number;
  onSaveToInbox: (transcript: string) => void;
  onDiscard: () => void;
  onClose: () => void;
}

type TabType = 'raw' | 'cleaned' | 'summary';

export function RecordingReviewModal({
  isOpen,
  rawTranscript,
  duration,
  onSaveToInbox,
  onDiscard,
  onClose
}: RecordingReviewModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>('raw');
  const [editedRawTranscript, setEditedRawTranscript] = useState('');
  const [editedCleanedTranscript, setEditedCleanedTranscript] = useState('');
  const [cleanedTranscript, setCleanedTranscript] = useState('');
  const [summary, setSummary] = useState('');
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Initialize transcripts when modal opens
  useEffect(() => {
    if (isOpen) {
      setEditedRawTranscript(rawTranscript);
      // Generate cleaned transcript immediately (even if raw is empty)
      const cleaned = cleanupTranscript(rawTranscript);
      setCleanedTranscript(cleaned);
      setEditedCleanedTranscript(cleaned);
      // Reset summary state
      setSummary('');
      setSummaryError(null);
    }
  }, [isOpen, rawTranscript]);

  // Generate summary when switching to summary tab (lazy loading)
  useEffect(() => {
    if (activeTab === 'summary' && !summary && !isGeneratingSummary && duration >= 30) {
      generateSummary();
    }
  }, [activeTab, summary, isGeneratingSummary, duration]);

  const generateSummary = useCallback(async () => {
    if (!rawTranscript || duration < 30) {
      setSummaryError('Recording must be at least 30 seconds to generate summary');
      return;
    }

    setIsGeneratingSummary(true);
    setSummaryError(null);

    try {
      const response = await fetch('/api/ai/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: rawTranscript,
          max_tokens: 300
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to generate summary: ${response.statusText}`);
      }

      const data = await response.json();
      setSummary(data.summary || '');
    } catch (err) {
      console.error('Failed to generate summary:', err);
      setSummaryError(err instanceof Error ? err.message : 'Failed to generate summary');
    } finally {
      setIsGeneratingSummary(false);
    }
  }, [rawTranscript, duration]);

  const handleSave = () => {
    // Save the transcript from the current active tab
    let transcriptToSave = '';
    switch (activeTab) {
      case 'raw':
        transcriptToSave = editedRawTranscript;
        break;
      case 'cleaned':
        transcriptToSave = editedCleanedTranscript;
        break;
      case 'summary':
        transcriptToSave = summary || editedCleanedTranscript;
        break;
    }
    onSaveToInbox(transcriptToSave);
  };

  const handleDiscard = () => {
    if (confirm('Are you sure you want to discard this recording? This cannot be undone.')) {
      onDiscard();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-2xl mx-4 bg-background border border-border rounded-lg shadow-lg flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold">Recording Complete</h2>
            <p className="text-sm text-muted-foreground">
              {formatDuration(duration)} • {new Date().toLocaleTimeString()}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Tab Headers */}
        <div className="flex border-b border-border">
          <button
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'raw'
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('raw')}
          >
            Raw
          </button>
          <button
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'cleaned'
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('cleaned')}
          >
            Cleaned
          </button>
          <button
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'summary'
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('summary')}
          >
            Summary
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'raw' && (
            <div className="space-y-2">
              <Textarea
                value={editedRawTranscript}
                onChange={(e) => setEditedRawTranscript(e.target.value)}
                className="min-h-[300px] font-mono text-sm"
                placeholder="No transcript available"
              />
              <p className="text-xs text-muted-foreground">
                Raw transcript as received from ASR engine. Fully editable.
              </p>
            </div>
          )}

          {activeTab === 'cleaned' && (
            <div className="space-y-2">
              <Textarea
                value={editedCleanedTranscript}
                onChange={(e) => setEditedCleanedTranscript(e.target.value)}
                className="min-h-[300px] text-sm"
                placeholder="No transcript available"
              />
              <p className="text-xs text-muted-foreground">
                Cleaned version with filler words removed and punctuation improved. Fully editable.
              </p>
            </div>
          )}

          {activeTab === 'summary' && (
            <div className="space-y-4">
              {duration < 30 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <p className="text-muted-foreground mb-2">
                    Summary requires at least 30 seconds of recording
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Current duration: {formatDuration(duration)}
                  </p>
                </div>
              ) : isGeneratingSummary ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
                  <p className="text-muted-foreground">Generating summary...</p>
                </div>
              ) : summaryError ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <p className="text-destructive mb-4">{summaryError}</p>
                  <Button variant="outline" size="sm" onClick={generateSummary}>
                    Retry
                  </Button>
                </div>
              ) : summary ? (
                <div className="space-y-2">
                  <div className="prose prose-sm max-w-none">
                    <div className="whitespace-pre-wrap text-sm">{summary}</div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    AI-generated summary. Read-only.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12">
                  <p className="text-muted-foreground mb-4">
                    Summary will be generated when you view this tab
                  </p>
                  <Button variant="outline" size="sm" onClick={generateSummary}>
                    Generate Now
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Action Bar */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border">
          <Button variant="outline" onClick={handleDiscard}>
            Discard
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Save as Draft
            </Button>
            <Button onClick={handleSave}>
              Save to Inbox
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
