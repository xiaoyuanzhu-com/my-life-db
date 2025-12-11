import { useState, useRef, useEffect, useCallback } from 'react';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { Upload, X, Plus } from 'lucide-react';
import { cn } from '~/lib/utils';
import { SearchStatus } from './search-status';
import type { SearchResponse } from '~/routes/api.search';
import * as tus from 'tus-js-client';

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
}

const SEARCH_BATCH_SIZE = 30;
// Use TUS for all uploads to enable progress tracking and resumability
// Set to 0 to always use TUS (recommended for homelab with fast network)
// Alternative: set to 100 * 1024 * 1024 (100MB) for hybrid approach
const TUS_THRESHOLD = 0;

interface UploadProgress {
  filename: string;
  bytesUploaded: number;
  bytesTotal: number;
  percentage: number;
}

export function OmniInput({ onEntryCreated, onSearchResultsChange, searchStatus, maxHeight }: OmniInputProps) {
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<Map<string, UploadProgress>>(new Map());
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Adaptive debounce for search
  const getSearchDebounceDelay = useCallback((queryLength: number): number => {
    if (queryLength === 0) return 0; // No search for empty input
    if (queryLength === 1) return 1000; // Long wait for single char
    if (queryLength === 2) return 500; // Medium wait for two chars
    return 100; // Fast for 3+ chars
  }, []);

  // Perform search - fires keyword and semantic in parallel
  const performSearch = useCallback(async (query: string) => {
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
    setIsSemanticSearching(true);
    setKeywordError(null);
    setSemanticError(null);

    // Fire keyword search
    const fetchKeyword = async () => {
      try {
        const params = new URLSearchParams({ q: query, types: 'keyword', limit: String(SEARCH_BATCH_SIZE) });
        const response = await fetch(`/api/search?${params}`, {
          signal: keywordController.signal,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        const data: SearchResponse = await response.json();
        if (!keywordController.signal.aborted) {
          setKeywordResults(data);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('Keyword search error:', err);
        const errorMsg = err instanceof Error ? err.message : 'Keyword search failed';
        if (!keywordController.signal.aborted) {
          setKeywordError(errorMsg);
        }
      } finally {
        if (!keywordController.signal.aborted) {
          setIsKeywordSearching(false);
        }
      }
    };

    // Fire semantic search
    const fetchSemantic = async () => {
      try {
        const params = new URLSearchParams({ q: query, types: 'semantic', limit: String(SEARCH_BATCH_SIZE) });
        const response = await fetch(`/api/search?${params}`, {
          signal: semanticController.signal,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        const data: SearchResponse = await response.json();
        if (!semanticController.signal.aborted) {
          setSemanticResults(data);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('Semantic search error:', err);
        const errorMsg = err instanceof Error ? err.message : 'Semantic search failed';
        if (!semanticController.signal.aborted) {
          setSemanticError(errorMsg);
        }
      } finally {
        if (!semanticController.signal.aborted) {
          setIsSemanticSearching(false);
        }
      }
    };

    // Fire both in parallel
    fetchKeyword();
    fetchSemantic();
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
      setKeywordResults(null);
      setSemanticResults(null);
      setKeywordError(null);
      setSemanticError(null);
      setIsKeywordSearching(false);
      setIsSemanticSearching(false);
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

    if (!content.trim() && selectedFiles.length === 0) {
      setError('Please enter some content or select files');
      return;
    }

    setIsLoading(true);
    setIsUploading(true);
    setError('');

    try {
      const trimmed = content.trim();

      // Check if any files need tus upload (larger than threshold)
      const largeFiles = selectedFiles.filter(f => f.size > TUS_THRESHOLD);
      const smallFiles = selectedFiles.filter(f => f.size <= TUS_THRESHOLD);

      if (largeFiles.length > 0) {
        // Use tus for large files
        await handleTusUpload(trimmed, largeFiles, smallFiles);
      } else {
        // Use regular FormData upload for small files
        await handleRegularUpload(trimmed, smallFiles);
      }

      // Clear state (will also clear sessionStorage via the effect)
      setContent('');
      setSelectedFiles([]);
      setUploadProgress(new Map());
      setKeywordResults(null);
      setSemanticResults(null);
      setKeywordError(null);
      setSemanticError(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      onEntryCreated?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg ? `Failed to save: ${msg}` : 'Failed to save entry. Please try again.');
      console.error('Inbox save failed:', err);
    } finally {
      setIsLoading(false);
      setIsUploading(false);
    }
  }

  async function handleRegularUpload(text: string, files: File[]) {
    const formData = new FormData();
    if (text) {
      formData.append('text', text);
    }

    files.forEach((file) => {
      formData.append('files', file);
    });

    const response = await fetch('/api/inbox', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      let details = '';
      try {
        const data = await response.json();
        details = data?.error || data?.details || '';
      } catch {
        // ignore
      }
      throw new Error(details || `HTTP ${response.status}`);
    }
  }

  async function handleTusUpload(text: string, largeFiles: File[], smallFiles: File[]) {
    // Upload all files using tus
    const allFiles = [...smallFiles, ...largeFiles];
    const uploadResults: Array<{
      uploadId: string;
      filename: string;
      size: number;
      type: string;
    }> = [];

    // Upload each file with tus
    for (const file of allFiles) {
      const uploadId = await uploadFileWithTus(file);
      uploadResults.push({
        uploadId,
        filename: file.name,
        size: file.size,
        type: file.type,
      });
    }

    // Finalize the upload
    const response = await fetch('/api/upload/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        uploads: uploadResults,
        text: text || undefined,
      }),
    });

    if (!response.ok) {
      let details = '';
      try {
        const data = await response.json();
        details = data?.error || '';
      } catch {
        // ignore
      }
      throw new Error(details || `HTTP ${response.status}`);
    }
  }

  function uploadFileWithTus(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const upload = new tus.Upload(file, {
        endpoint: '/api/upload/tus',
        retryDelays: [0, 1000, 3000, 5000],
        // 10MB chunks - balances speed and reliability
        chunkSize: 10 * 1024 * 1024,
        metadata: {
          filename: file.name,
          filetype: file.type,
        },
        onError: (error) => {
          console.error('[TUS] Upload failed:', error);
          setUploadProgress(prev => {
            const next = new Map(prev);
            next.delete(file.name);
            return next;
          });
          reject(error);
        },
        onProgress: (bytesUploaded, bytesTotal) => {
          const percentage = Math.round((bytesUploaded / bytesTotal) * 100);
          setUploadProgress(prev => {
            const next = new Map(prev);
            next.set(file.name, {
              filename: file.name,
              bytesUploaded,
              bytesTotal,
              percentage,
            });
            return next;
          });
        },
        onSuccess: () => {
          console.log('[TUS] Upload complete:', file.name);
          // Extract upload ID from URL
          const url = upload.url;
          if (!url) {
            reject(new Error('No upload URL returned'));
            return;
          }
          const uploadId = url.split('/').pop();
          if (!uploadId) {
            reject(new Error('Could not extract upload ID'));
            return;
          }
          resolve(uploadId);
        },
      });

      upload.findPreviousUploads().then((previousUploads) => {
        if (previousUploads.length) {
          upload.resumeFromPreviousUpload(previousUploads[0]);
        }
        upload.start();
      });
    });
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
    // macOS shows: 722.9 MB for a file that's actually 689 MiB
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
        <Textarea
          id="omni-input"
          name="content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (content.trim() || selectedFiles.length > 0) {
                handleSubmit(e);
              }
            }
          }}
          placeholder="What's up?"
          disabled={isLoading}
          style={maxHeight ? { maxHeight } : undefined}
          className={cn(
            'border-0 bg-transparent shadow-none text-base resize-none cursor-text overflow-y-auto',
            'focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-0',
            'placeholder:text-muted-foreground/50 min-h-9 px-4 pt-2'
          )}
          aria-invalid={!!error}
        />

        {/* File chips above control bar */}
        {selectedFiles.length > 0 && (
          <div className="flex flex-col gap-2 px-4 pb-2">
            {selectedFiles.map((file, index) => {
              const progress = uploadProgress.get(file.name);
              const isUploading = progress !== undefined;

              return (
                <div
                  key={index}
                  className={cn(
                    'flex items-center gap-2 relative overflow-hidden',
                    'bg-muted rounded-md p-2'
                  )}
                >
                  {/* Progress bar as background */}
                  {isUploading && (
                    <div
                      className="absolute inset-0 bg-primary/10 transition-all duration-300 ease-out"
                      style={{ width: `${progress.percentage}%` }}
                    />
                  )}

                  {/* Content on top of progress bar */}
                  <Upload className="h-4 w-4 text-muted-foreground flex-shrink-0 relative z-10" />
                  <div className="flex-1 min-w-0 flex items-center gap-2 relative z-10">
                    <span className="text-sm truncate flex-1">{file.name}</span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {isUploading ? `${progress.percentage}%` : formatFileSize(file.size)}
                    </span>
                  </div>
                  {!isUploading && (
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="hover:bg-background rounded-full p-1 transition-colors flex-shrink-0 relative z-10"
                      aria-label="Remove file"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Bottom control bar - floating buttons */}
        <div className="flex items-center justify-between px-3 h-9">
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

          {/* Show search status in the middle */}
          {searchStatus && (searchStatus.isSearching || searchStatus.hasNoResults || searchStatus.hasError || (searchStatus.resultCount && searchStatus.resultCount > 0)) && (
            <SearchStatus
              isSearching={searchStatus.isSearching}
              hasNoResults={searchStatus.hasNoResults}
              hasError={searchStatus.hasError}
              resultCount={searchStatus.resultCount}
            />
          )}

          <Button
            type="submit"
            disabled={isLoading || isUploading}
            size="sm"
            className="h-7 cursor-pointer"
          >
            <span>{isUploading ? 'Uploading...' : 'Send'}</span>
          </Button>
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
          accept="image/*,application/pdf,.doc,.docx,.txt,.md"
        />
      </form>
    </div>
  );
}
