import { useState, useRef, useEffect, useCallback } from 'react';
import { Textarea } from '../ui/textarea';
import { Button } from '../ui/button';
import { Upload, Plus, Mic } from 'lucide-react';
import { cn } from '~/lib/utils';
import { SearchStatus } from '../search-status';
import { useSendQueue } from '~/lib/send-queue';
import type { SearchResponse } from '~/types/api';

// Presentational components
import { AudioWaveform } from './ui/audio-waveform';
import { RecordingTimer } from './ui/recording-timer';
import { TranscriptOverlay } from './ui/transcript-overlay';
import { FileAttachments } from './ui/file-attachments';

// Business logic modules
import { useVoiceInputWithSaveAudio } from './modules/use-voice-input';
import { useSearch } from './modules/use-search';
import { useFileDrag } from './modules/use-file-drag';

interface OmniInputProps {
  onEntryCreated?: () => void;
  onSearchResultsChange?: (state: {
    keywordResults: SearchResponse | null;
    semanticResults: SearchResponse | null;
    isKeywordSearching: boolean;
    isSemanticSearching: boolean;
    keywordError: string | null;
    semanticError: string | null;
  }) => void;
  maxHeight?: number;
  searchStatus?: {
    isSearching: boolean;
    hasNoResults: boolean;
    hasError: boolean;
    resultCount?: number;
  };
  clearSearchTrigger?: number;
}

export function OmniInput({
  onEntryCreated,
  onSearchResultsChange,
  searchStatus,
  maxHeight,
  clearSearchTrigger
}: OmniInputProps) {
  // Local UI state
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [saveAudio, setSaveAudio] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // SessionStorage key for persisting text
  const STORAGE_KEY = 'omni-input:text';

  // Delegate to business logic modules
  const voice = useVoiceInputWithSaveAudio({ onError: setError });
  const search = useSearch({ onResultsChange: onSearchResultsChange });
  const files = useFileDrag();

  // Keep saveAudio ref in sync
  useEffect(() => {
    voice.saveAudioRef.current = saveAudio;
  }, [saveAudio, voice.saveAudioRef]);

  // Use the local-first send queue
  const { send } = useSendQueue(() => {
    onEntryCreated?.();
  });

  // Auto-resize textarea
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [content, voice.transcript.finalized, voice.transcript.partial, adjustTextareaHeight]);

  // Coordination: When recording stops and refinement completes, append transcript to content
  const wasRecordingRef = useRef(false);
  const wasRefiningRef = useRef(false);
  const transcriptAppendedRef = useRef(false);

  useEffect(() => {
    // Reset flag when starting new recording
    if (voice.isRecording && !wasRecordingRef.current) {
      transcriptAppendedRef.current = false;
    }

    wasRecordingRef.current = voice.isRecording;
  }, [voice.isRecording]);

  useEffect(() => {
    // Only append transcript when refinement completes
    const refinementJustCompleted = wasRefiningRef.current && !voice.isRefining;

    if (refinementJustCompleted && !transcriptAppendedRef.current) {
      const finalTranscript = voice.transcript.finalized.trim();
      if (finalTranscript) {
        setContent(prev => {
          const trimmed = prev.trim();
          return trimmed ? `${trimmed} ${finalTranscript}` : finalTranscript;
        });
        transcriptAppendedRef.current = true;
      }
    }

    wasRefiningRef.current = voice.isRefining;
  }, [voice.isRefining, voice.transcript.finalized]);

  // Coordination: When content changes, trigger search
  const { search: performSearch } = search;
  useEffect(() => {
    performSearch(content);
  }, [content, performSearch]);

  // Coordination: When voice recording completes with audio, add to files
  useEffect(() => {
    if (voice.recordedAudio && saveAudio) {
      const audioFile = new File([voice.recordedAudio], `recording-${Date.now()}.webm`, {
        type: 'audio/webm'
      });
      files.addFiles([audioFile]);
    }
  }, [voice.recordedAudio, saveAudio, files]);

  // Restore content from sessionStorage on mount
  useEffect(() => {
    try {
      const savedContent = sessionStorage.getItem(STORAGE_KEY);
      if (savedContent) {
        setContent(savedContent);
      }
    } catch (error) {
      console.error('Failed to restore content from sessionStorage:', error);
    }
  }, []);

  // Save content to sessionStorage whenever it changes
  useEffect(() => {
    try {
      if (content) {
        sessionStorage.setItem(STORAGE_KEY, content);
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch (error) {
      console.error('Failed to save content to sessionStorage:', error);
    }
  }, [content]);

  // Clear search when clearSearchTrigger changes
  const { clear: clearSearch } = search;
  useEffect(() => {
    if (clearSearchTrigger && clearSearchTrigger > 0) {
      setContent('');
      clearSearch();
    }
  }, [clearSearchTrigger, clearSearch]);

  // Submit handler
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (voice.isRecording) {
      return;
    }

    const trimmed = content.trim();
    if (!trimmed && files.files.length === 0) {
      setError('Please enter some content or select files');
      return;
    }

    setError('');

    try {
      await send(trimmed || undefined, files.files);

      // Clear input immediately
      setContent('');
      files.clear();
      search.clear();
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      onEntryCreated?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg ? `Failed to save: ${msg}` : 'Failed to save entry. Please try again.');
      console.error('Inbox save failed:', err);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = e.target.files;
    if (selectedFiles && selectedFiles.length > 0) {
      files.addFiles(Array.from(selectedFiles));
      setError('');
    }
  }

  // UI COMPOSITION - OmniInput owns all layout decisions
  return (
    <div className="w-full">
      <form onSubmit={handleSubmit} className="w-full">
        <div
          className={cn(
            'relative rounded-xl border transition-all overflow-hidden',
            'bg-muted',
            files.isDragging
              ? 'border-primary bg-primary/5'
              : 'border-border',
            'hover:border-primary/50 focus-within:border-primary'
          )}
          {...files.handlers}
        >
          {/* Textarea with transcript overlay */}
          <div className="relative">
            <Textarea
              ref={textareaRef}
              id="omni-input"
              name="content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !voice.isRecording) {
                  e.preventDefault();
                  if (content.trim() || files.files.length > 0) {
                    handleSubmit(e);
                  }
                }
              }}
              placeholder={voice.isRecording ? '' : "What's up?"}
              style={maxHeight ? { maxHeight } : undefined}
              className={cn(
                'border-0 bg-transparent shadow-none text-base resize-none cursor-text',
                'focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-0',
                'placeholder:text-muted-foreground/50 min-h-[2.25rem] max-h-[50vh] overflow-y-auto px-4 pt-2'
              )}
              aria-invalid={!!error}
              disabled={voice.isRecording}
            />

            {/* Transcript overlay during recording */}
            {voice.isRecording && (
              <TranscriptOverlay
                existingContent={content}
                finalizedText={voice.transcript.finalized}
                partialText={voice.transcript.partial}
              />
            )}
          </div>

          {/* File chips */}
          <FileAttachments files={files.files} onRemove={files.removeFile} />

          {/* Bottom control bar */}
          <div className="flex items-center justify-between px-3 h-9">
            {/* Left: Add file button */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Add file"
            >
              <Plus className="h-4 w-4" />
            </Button>

            {/* Middle: Voice controls OR search status */}
            <div className="flex-1 flex items-center justify-center">
              {voice.isRecording ? (
                <div className="flex items-center gap-3">
                  <AudioWaveform level={voice.audioLevel} />
                  <RecordingTimer seconds={voice.duration} />
                  <label className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={saveAudio}
                      onChange={(e) => setSaveAudio(e.target.checked)}
                      className="w-3 h-3 rounded border-border bg-background text-primary focus:ring-1 focus:ring-primary cursor-pointer"
                    />
                    <span className="text-xs text-muted-foreground select-none">Save Audio</span>
                  </label>
                </div>
              ) : searchStatus && (searchStatus.isSearching || searchStatus.hasNoResults || searchStatus.hasError || (searchStatus.resultCount && searchStatus.resultCount > 0)) ? (
                <SearchStatus
                  isSearching={searchStatus.isSearching}
                  hasNoResults={searchStatus.hasNoResults}
                  hasError={searchStatus.hasError}
                  resultCount={searchStatus.resultCount}
                />
              ) : null}
            </div>

            {/* Right: Stop button OR Send button OR Mic button */}
            {voice.isRecording && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-8 px-3 cursor-pointer gap-2"
                onClick={voice.stop}
                aria-label="Stop recording"
              >
                <div className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
                </div>
                <Mic className="h-4 w-4" />
                <span className="text-xs font-medium">Stop</span>
              </Button>
            )}

            {!voice.isRecording && (content.trim() || files.files.length > 0) && (
              <Button
                type="submit"
                size="sm"
                className="h-7 cursor-pointer"
              >
                Send
              </Button>
            )}

            {!voice.isRecording && !content.trim() && files.files.length === 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0 cursor-pointer"
                onClick={voice.start}
                aria-label="Start voice input"
              >
                <Mic className="h-5 w-5" />
              </Button>
            )}
          </div>

          {/* Drag overlay */}
          {files.isDragging && (
            <div className="absolute inset-0 flex items-center justify-center bg-primary/5 rounded-xl pointer-events-none">
              <div className="text-center">
                <Upload className="h-12 w-12 mx-auto mb-2 text-primary" />
                <p className="text-sm font-medium text-primary">Drop files here</p>
              </div>
            </div>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive mt-2">{error}</p>
        )}

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileSelect}
          multiple
        />
      </form>
    </div>
  );
}
