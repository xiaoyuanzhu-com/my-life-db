import { useState, useRef, useEffect, useCallback } from 'react';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { Upload, X, Plus, Mic } from 'lucide-react';
import { cn } from '~/lib/utils';
import { SearchStatus } from './search-status';
import { InlineWaveform } from './inline-waveform';
import type { SearchResponse } from '~/types/api';
import { useSendQueue } from '~/lib/send-queue';
import { useRealtimeASR } from '~/hooks/use-realtime-asr';

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

const SEARCH_BATCH_SIZE = 30;

export function OmniInput({ onEntryCreated, onSearchResultsChange, searchStatus, maxHeight, clearSearchTrigger }: OmniInputProps) {
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Use the local-first send queue
  const { send } = useSendQueue(() => {
    // Called when an upload completes - refresh the inbox
    onEntryCreated?.();
  });

  // Real-time ASR hook
  const { isRecording, audioLevel, recordingDuration, rawTranscript, partialSentence, startRecording, stopRecording: stopRecordingRaw } = useRealtimeASR({
    onError: (errorMsg) => {
      setError(`Voice input error: ${errorMsg}`);
      console.error('ASR error:', errorMsg);
    }
  });

  // Auto-resize textarea based on content
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = 'auto';
    // Set height to scrollHeight, but respect max-height
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  // Adjust height when content or transcript changes
  useEffect(() => {
    adjustTextareaHeight();
  }, [content, rawTranscript, partialSentence, adjustTextareaHeight]);

  // Track transcript in ref to avoid stale closure issues
  const rawTranscriptRef = useRef('');
  useEffect(() => {
    rawTranscriptRef.current = rawTranscript;
  }, [rawTranscript]);

  // Wrap stopRecording to append transcript to content
  const stopRecording = useCallback(() => {
    // Capture transcript BEFORE stopping
    const finalTranscript = rawTranscriptRef.current.trim();

    // Stop the recording
    stopRecordingRaw();

    // Append transcript to content
    if (finalTranscript) {
      setContent(prev => {
        const trimmed = prev.trim();
        return trimmed ? `${trimmed} ${finalTranscript}` : finalTranscript;
      });
    }
  }, [stopRecordingRaw]);

  // Search state - separate tracking for keyword and semantic
  const [keywordResults, setKeywordResults] = useState<SearchResponse | null>(null);
  const [semanticResults, setSemanticResults] = useState<SearchResponse | null>(null);
  const [isKeywordSearching, setIsKeywordSearching] = useState(false);
  const [isSemanticSearching, setIsSemanticSearching] = useState(false);
  const [keywordError, setKeywordError] = useState<string | null>(null);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const keywordAbortRef = useRef<AbortController | null>(null);
  const semanticAbortRef = useRef<AbortController | null>(null);
  // Track the current query to prevent stale responses from updating state
  const currentQueryRef = useRef<string>('');

  // SessionStorage key for persisting text
  const STORAGE_KEY = 'omni-input:text';

  // Restore content from sessionStorage on mount
  useEffect(() => {
    try {
      const savedContent = sessionStorage.getItem(STORAGE_KEY);
      if (savedContent) {
        setContent(savedContent);
        // Search will be triggered automatically by the search effect when content changes
      }
    } catch (error) {
      console.error('Failed to restore content from sessionStorage:', error);
    }
  }, []); // Only run on mount

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

  // Clear search when clearSearchTrigger changes (used by "Locate" action)
  useEffect(() => {
    if (clearSearchTrigger && clearSearchTrigger > 0) {
      setContent('');
      setKeywordResults(null);
      // TEMPORARILY DISABLED: Don't clear semantic results (semantic search disabled)
      // setSemanticResults(null);
      setKeywordError(null);
      // TEMPORARILY DISABLED: Don't clear semantic error (semantic search disabled)
      // setSemanticError(null);
    }
  }, [clearSearchTrigger]);

  // Adaptive debounce for search
  const getSearchDebounceDelay = useCallback((queryLength: number): number => {
    if (queryLength === 0) return 0; // No search for empty input
    if (queryLength === 1) return 1000; // Long wait for single char
    if (queryLength === 2) return 500; // Medium wait for two chars
    return 100; // Fast for 3+ chars
  }, []);

  // Perform search - fires keyword and semantic in parallel
  const performSearch = useCallback(async (query: string) => {
    // Update the current query ref to track which query we're searching for
    currentQueryRef.current = query;

    if (!query || query.length < 2) {
      setKeywordResults(null);
      setSemanticResults(null);
      setKeywordError(null);
      setSemanticError(null);
      return;
    }

    // Cancel previous searches
    keywordAbortRef.current?.abort();
    semanticAbortRef.current?.abort();

    const keywordController = new AbortController();
    const semanticController = new AbortController();
    keywordAbortRef.current = keywordController;
    semanticAbortRef.current = semanticController;

    // Start both searches
    setIsKeywordSearching(true);
    // TEMPORARILY DISABLED: Semantic search
    // setIsSemanticSearching(true);
    setKeywordError(null);
    // TEMPORARILY DISABLED: Clear semantic error
    // setSemanticError(null);

    // Capture the query for this search to check staleness
    const searchQuery = query;

    // Fire keyword search
    const fetchKeyword = async () => {
      try {
        const params = new URLSearchParams({ q: searchQuery, types: 'keyword', limit: String(SEARCH_BATCH_SIZE) });
        const response = await fetch(`/api/search?${params}`, {
          signal: keywordController.signal,
          credentials: 'same-origin',
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        const data: SearchResponse = await response.json();
        // Only update state if this response is for the current query
        if (currentQueryRef.current === searchQuery) {
          setKeywordResults(data);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('Keyword search error:', err);
        const errorMsg = err instanceof Error ? err.message : 'Keyword search failed';
        if (currentQueryRef.current === searchQuery) {
          setKeywordError(errorMsg);
        }
      } finally {
        if (currentQueryRef.current === searchQuery) {
          setIsKeywordSearching(false);
        }
      }
    };

    // TEMPORARILY DISABLED: Semantic search
    // // Fire semantic search
    // const fetchSemantic = async () => {
    //   try {
    //     const params = new URLSearchParams({ q: searchQuery, types: 'semantic', limit: String(SEARCH_BATCH_SIZE) });
    //     const response = await fetch(`/api/search?${params}`, {
    //       signal: semanticController.signal,
    //       credentials: 'same-origin',
    //     });

    //     if (!response.ok) {
    //       const errorData = await response.json().catch(() => ({}));
    //       throw new Error(errorData.error || `HTTP ${response.status}`);
    //     }

    //     const data: SearchResponse = await response.json();
    //     // Only update state if this response is for the current query
    //     if (currentQueryRef.current === searchQuery) {
    //       setSemanticResults(data);
    //     }
    //   } catch (err) {
    //     if (err instanceof Error && err.name === 'AbortError') return;
    //     console.error('Semantic search error:', err);
    //     const errorMsg = err instanceof Error ? err.message : 'Semantic search failed';
    //     if (currentQueryRef.current === searchQuery) {
    //       setSemanticError(errorMsg);
    //     }
    //   } finally {
    //     if (currentQueryRef.current === searchQuery) {
    //       setIsSemanticSearching(false);
    //     }
    //   }
    // };

    // Fire keyword search only (semantic search disabled)
    fetchKeyword();
    // TEMPORARILY DISABLED: Semantic search
    // fetchSemantic();
  }, []);

  // Notify parent of search state changes
  useEffect(() => {
    onSearchResultsChange?.({
      keywordResults,
      semanticResults,
      isKeywordSearching,
      isSemanticSearching,
      keywordError,
      semanticError,
    });
  }, [keywordResults, semanticResults, isKeywordSearching, isSemanticSearching, keywordError, semanticError, onSearchResultsChange]);

  // Effect to trigger adaptive debounced search
  useEffect(() => {
    // Clear existing timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    const query = content.trim();
    const delay = getSearchDebounceDelay(query.length);

    // Clear results immediately if empty
    if (!query) {
      // Update ref so any in-flight responses are ignored as stale
      currentQueryRef.current = '';
      setKeywordResults(null);
      // TEMPORARILY DISABLED: Don't clear semantic results (semantic search disabled)
      // setSemanticResults(null);
      setKeywordError(null);
      // TEMPORARILY DISABLED: Don't clear semantic error (semantic search disabled)
      // setSemanticError(null);
      setIsKeywordSearching(false);
      // TEMPORARILY DISABLED: Don't update semantic searching state (semantic search disabled)
      // setIsSemanticSearching(false);
      return;
    }

    // Set new timeout for search with adaptive delay
    searchTimeoutRef.current = setTimeout(() => {
      performSearch(query);
    }, delay);

    // Cleanup
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [content, getSearchDebounceDelay, performSearch]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Don't submit while recording
    if (isRecording) {
      return;
    }

    const trimmed = content.trim();
    if (!trimmed && selectedFiles.length === 0) {
      setError('Please enter some content or select files');
      return;
    }

    setError('');

    try {
      // Local-first: save to IndexedDB immediately, upload in background
      // This is instant and never blocks - items appear in feed immediately
      await send(trimmed || undefined, selectedFiles);

      // Clear input immediately (< 50ms as per design)
      setContent('');
      setSelectedFiles([]);
      setKeywordResults(null);
      // TEMPORARILY DISABLED: Don't clear semantic results (semantic search disabled)
      // setSemanticResults(null);
      setKeywordError(null);
      // TEMPORARILY DISABLED: Don't clear semantic error (semantic search disabled)
      // setSemanticError(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      // Notify parent to refresh feed (will show local items)
      onEntryCreated?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg ? `Failed to save: ${msg}` : 'Failed to save entry. Please try again.');
      console.error('Inbox save failed:', err);
    }
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setSelectedFiles(prev => [...prev, ...files]);
      setError('');
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) {
      setSelectedFiles(prev => [...prev, ...Array.from(files)]);
      setError('');
    }
  }

  function removeFile(index: number) {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  }

  function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    // Use decimal (1000-based) units to match macOS Finder
    const k = 1000;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  return (
    <div className="w-full">
      <form onSubmit={handleSubmit} className="w-full">
        <div
          className={cn(
            'relative rounded-xl border transition-all overflow-hidden',
            'bg-muted',
            isDragging
              ? 'border-primary bg-primary/5'
              : 'border-border',
            'hover:border-primary/50 focus-within:border-primary'
          )}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
        {/* Textarea with regular placeholder */}
        <div className="relative">
          <Textarea
            ref={textareaRef}
            id="omni-input"
            name="content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => {
              // Don't allow Enter to submit while recording
              if (e.key === 'Enter' && !e.shiftKey && !isRecording) {
                e.preventDefault();
                if (content.trim() || selectedFiles.length > 0) {
                  handleSubmit(e);
                }
              }
            }}
            placeholder={isRecording ? '' : 'What\'s up?'}
            style={maxHeight ? { maxHeight } : undefined}
            className={cn(
              'border-0 bg-transparent shadow-none text-base resize-none cursor-text',
              'focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-0',
              'placeholder:text-muted-foreground/50 min-h-[2.25rem] max-h-[50vh] overflow-y-auto px-4 pt-2'
            )}
            aria-invalid={!!error}
            disabled={isRecording}
          />
          {/* Show transcript as gray overlay text during recording */}
          {isRecording && (rawTranscript || partialSentence) && (
            <div className="absolute inset-0 px-4 pt-2 pointer-events-none text-base whitespace-pre-wrap overflow-y-auto">
              <span className="invisible">{content}</span>
              <span className="text-foreground">
                {content ? ' ' : ''}
                {rawTranscript}
              </span>
              {partialSentence && (
                <span className="text-muted-foreground/60">
                  {rawTranscript ? ' ' : ''}
                  {partialSentence}
                </span>
              )}
            </div>
          )}
        </div>

        {/* File chips above control bar */}
        {selectedFiles.length > 0 && (
          <div className="flex flex-col gap-2 px-4 pb-2">
            {selectedFiles.map((file, index) => (
              <div
                key={index}
                className={cn(
                  'flex items-center gap-2 relative overflow-hidden',
                  'bg-muted rounded-md p-2'
                )}
              >
                <Upload className="h-4 w-4 text-muted-foreground flex-shrink-0 relative z-10" />
                <div className="flex-1 min-w-0 flex items-center gap-2 relative z-10">
                  <span className="text-sm truncate flex-1">{file.name}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatFileSize(file.size)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  className="hover:bg-background rounded-full p-1 transition-colors flex-shrink-0 relative z-10"
                  aria-label="Remove file"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Bottom control bar - floating buttons */}
        <div className="flex items-center justify-between px-3 h-9">
          {/* Left side: Add file button */}
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

          {/* Middle: Recording waveform + timer OR search status */}
          <div className="flex-1 flex items-center justify-center">
            {isRecording ? (
              <div className="flex items-center gap-3">
                <InlineWaveform audioLevel={audioLevel} />
                <span className="text-xs font-mono text-muted-foreground tabular-nums">
                  {Math.floor(recordingDuration / 60).toString().padStart(2, '0')}:
                  {(recordingDuration % 60).toString().padStart(2, '0')}
                </span>
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

          {/* Right side: Recording stop button OR Send button OR Mic button */}
          {isRecording && (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="h-8 px-3 cursor-pointer gap-2"
              onClick={stopRecording}
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

          {!isRecording && (content.trim() || selectedFiles.length > 0) && (
            <Button
              type="submit"
              size="sm"
              className="h-7 cursor-pointer"
            >
              Send
            </Button>
          )}

          {!isRecording && !content.trim() && selectedFiles.length === 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 cursor-pointer"
              onClick={startRecording}
              aria-label="Start voice input"
            >
              <Mic className="h-5 w-5" />
            </Button>
          )}
        </div>

        {isDragging && (
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
