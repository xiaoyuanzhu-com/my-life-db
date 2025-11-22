'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { Upload, X, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SearchStatus } from './search-status';
import type { SearchResponse } from '@/app/api/search/route';

interface OmniInputProps {
  onEntryCreated?: () => void;
  onSearchStateChange?: (state: {
    results: SearchResponse | null;
    isSearching: boolean;
    error: string | null;
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

export function OmniInput({ onEntryCreated, onSearchStateChange, searchStatus, maxHeight }: OmniInputProps) {
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Search state
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const searchAbortControllerRef = useRef<AbortController | null>(null);

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

  // Perform search
  const performSearch = useCallback(async (query: string) => {
    if (!query || query.length < 2) {
      setSearchResults(null);
      setSearchError(null);
      return;
    }

    // Cancel previous search
    if (searchAbortControllerRef.current) {
      searchAbortControllerRef.current.abort();
    }

    setIsSearching(true);
    setSearchError(null);

    const abortController = new AbortController();
    searchAbortControllerRef.current = abortController;

    try {
      const params = new URLSearchParams({ q: query, limit: String(SEARCH_BATCH_SIZE) });
      const response = await fetch(`/api/search?${params}`, {
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data: SearchResponse = await response.json();

      // Only update if this search wasn't cancelled
      if (!abortController.signal.aborted) {
        setSearchResults(data);
      }
    } catch (err) {
      // Ignore abort errors
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }

      console.error('Search error:', err);
      const errorMsg = err instanceof Error ? err.message : 'Search failed';
      setSearchError(errorMsg);
      setSearchResults(null);
    } finally {
      if (!abortController.signal.aborted) {
        setIsSearching(false);
      }
    }
  }, []);

  // Notify parent of search state changes
  useEffect(() => {
    onSearchStateChange?.({
      results: searchResults,
      isSearching,
      error: searchError,
    });
  }, [searchResults, isSearching, searchError, onSearchStateChange]);

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
      setSearchResults(null);
      setSearchError(null);
      setIsSearching(false);
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
    setError('');

    try {
      // Create FormData to support file uploads
      const formData = new FormData();
      // Align with new Inbox API (no date layer): expects `text` and `files`
      const trimmed = content.trim();
      if (trimmed.length > 0) {
        formData.append('text', trimmed);
      }

      // Add files to FormData
      selectedFiles.forEach((file) => {
        formData.append('files', file);
      });

      const response = await fetch('/api/inbox', {
        method: 'POST',
        body: formData, // Send as multipart/form-data
      });

      if (!response.ok) {
        // Try to surface server error details for easier debugging
        let details = '';
        try {
          const data = await response.json();
          details = data?.error || data?.details || '';
        } catch {
          // ignore
        }
        throw new Error(details || `HTTP ${response.status}`);
      }

      // Clear state (will also clear sessionStorage via the effect)
      setContent('');
      setSelectedFiles([]);
      setSearchResults(null); // Clear search results on submit
      setSearchError(null);
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
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="What's up?"
          disabled={isLoading}
          style={maxHeight ? { maxHeight } : undefined}
          className={cn(
            'border-0 bg-transparent shadow-none text-base resize-none cursor-text overflow-y-auto',
            'focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-0',
            'placeholder:text-muted-foreground/50 min-h-[40px] px-4 pt-3 pb-2'
          )}
          aria-invalid={!!error}
        />

        {/* File chips above control bar */}
        {selectedFiles.length > 0 && (
          <div className="flex items-center gap-2 px-4 pb-2 overflow-x-auto">
            {selectedFiles.map((file, index) => (
              <div
                key={index}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5',
                  'bg-muted rounded-md text-sm whitespace-nowrap flex-shrink-0'
                )}
              >
                <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="max-w-[120px] truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  className="ml-1 hover:bg-background rounded-full p-0.5 transition-colors"
                  aria-label="Remove file"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Bottom control bar - floating buttons */}
        <div className="flex items-center justify-between px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 cursor-pointer"
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
            disabled={isLoading}
            size="sm"
            className="h-8 cursor-pointer"
          >
            <span>Send</span>
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
