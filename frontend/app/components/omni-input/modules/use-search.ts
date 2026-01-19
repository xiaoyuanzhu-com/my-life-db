import { useState, useCallback, useRef, useEffect } from 'react';
import type { SearchResponse } from '~/types/api';

const SEARCH_BATCH_SIZE = 30;

export interface SearchState {
  keywordResults: SearchResponse | null;
  semanticResults: SearchResponse | null;
  isKeywordSearching: boolean;
  isSemanticSearching: boolean;
  keywordError: string | null;
  semanticError: string | null;
}

interface UseSearchOptions {
  onResultsChange?: (state: SearchState) => void;
}

export interface SearchControls {
  // State
  results: SearchState;
  isSearching: boolean;

  // Actions
  search: (query: string) => void;
  clear: () => void;
}

/**
 * Search hook - manages debounced search with keyword and semantic results
 * Handles API calls, error states, and debouncing
 * Returns data + controls, NO UI
 */
export function useSearch(options?: UseSearchOptions): SearchControls {
  const [keywordResults, setKeywordResults] = useState<SearchResponse | null>(null);
  const [semanticResults, setSemanticResults] = useState<SearchResponse | null>(null);
  const [isKeywordSearching, setIsKeywordSearching] = useState(false);
  const [isSemanticSearching, setIsSemanticSearching] = useState(false);
  const [keywordError, setKeywordError] = useState<string | null>(null);
  const [semanticError, setSemanticError] = useState<string | null>(null);

  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const keywordAbortRef = useRef<AbortController | null>(null);
  const semanticAbortRef = useRef<AbortController | null>(null);
  const currentQueryRef = useRef<string>('');

  // Adaptive debounce delay
  const getSearchDebounceDelay = useCallback((queryLength: number): number => {
    if (queryLength === 0) return 0;
    if (queryLength === 1) return 1000;
    if (queryLength === 2) return 500;
    return 100;
  }, []);

  // Perform search
  const performSearch = useCallback(async (query: string) => {
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

    // Start keyword search
    setIsKeywordSearching(true);
    setKeywordError(null);

    const searchQuery = query;

    // Keyword search
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

    fetchKeyword();
  }, []);

  // Search with debouncing
  const search = useCallback((query: string) => {
    // Clear existing timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    const trimmedQuery = query.trim();
    const delay = getSearchDebounceDelay(trimmedQuery.length);

    // Clear results immediately if empty
    if (!trimmedQuery) {
      currentQueryRef.current = '';
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
      performSearch(trimmedQuery);
    }, delay);
  }, [getSearchDebounceDelay, performSearch]);

  // Clear search
  const clear = useCallback(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    currentQueryRef.current = '';
    setKeywordResults(null);
    setSemanticResults(null);
    setKeywordError(null);
    setSemanticError(null);
    setIsKeywordSearching(false);
    setIsSemanticSearching(false);
  }, []);

  // Notify on changes
  useEffect(() => {
    options?.onResultsChange?.({
      keywordResults,
      semanticResults,
      isKeywordSearching,
      isSemanticSearching,
      keywordError,
      semanticError,
    });
  }, [keywordResults, semanticResults, isKeywordSearching, isSemanticSearching, keywordError, semanticError, options]);

  // Build results state
  const results: SearchState = {
    keywordResults,
    semanticResults,
    isKeywordSearching,
    isSemanticSearching,
    keywordError,
    semanticError,
  };

  return {
    results,
    isSearching: isKeywordSearching || isSemanticSearching,
    search,
    clear,
  };
}
