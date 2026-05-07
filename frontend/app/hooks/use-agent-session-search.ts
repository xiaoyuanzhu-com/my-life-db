import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '~/lib/api'
import type {
  AgentSessionSearchPagination,
  AgentSessionSearchResponse,
  AgentSessionSearchResult,
} from '~/types/agent-search'

const PAGE_SIZE = 20
const DEBOUNCE_MS = 250
const MIN_QUERY_LENGTH = 2

export interface UseAgentSessionSearch {
  query: string
  results: AgentSessionSearchResult[]
  pagination: AgentSessionSearchPagination | null
  isSearching: boolean
  error: string | null
  search: (query: string) => void
  loadMore: () => void
  clear: () => void
}

export function useAgentSessionSearch(): UseAgentSessionSearch {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AgentSessionSearchResult[]>([])
  const [pagination, setPagination] = useState<AgentSessionSearchPagination | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const currentQueryRef = useRef<string>('')

  const performSearch = useCallback(
    async (q: string, offset: number, append: boolean) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsSearching(true)
      setError(null)

      try {
        const params = new URLSearchParams({
          q,
          limit: String(PAGE_SIZE),
          offset: String(offset),
        })
        const response = await api.get(`/api/agent/sessions/search?${params}`, {
          signal: controller.signal,
        })

        if (!response.ok) {
          const body = await response.json().catch(() => ({}))
          const message: string =
            (body && body.error && typeof body.error.message === 'string'
              ? body.error.message
              : '') || `HTTP ${response.status}`
          throw new Error(message)
        }

        const data: AgentSessionSearchResponse = await response.json()
        if (currentQueryRef.current !== q) return
        setResults((prev) => (append ? [...prev, ...data.results] : data.results))
        setPagination(data.pagination)
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return
        if (currentQueryRef.current !== q) return
        setError(err instanceof Error ? err.message : 'Search failed')
      } finally {
        if (currentQueryRef.current === q) setIsSearching(false)
      }
    },
    [],
  )

  const reset = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    abortRef.current?.abort()
    abortRef.current = null
    currentQueryRef.current = ''
    setResults([])
    setPagination(null)
    setError(null)
    setIsSearching(false)
  }, [])

  const search = useCallback(
    (next: string) => {
      setQuery(next)
      const trimmed = next.trim()
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      if (trimmed.length < MIN_QUERY_LENGTH) {
        // Cancel any in-flight request and clear results, but don't surface an error.
        abortRef.current?.abort()
        abortRef.current = null
        currentQueryRef.current = ''
        setResults([])
        setPagination(null)
        setError(null)
        setIsSearching(false)
        return
      }
      currentQueryRef.current = trimmed
      debounceRef.current = setTimeout(() => {
        performSearch(trimmed, 0, false)
      }, DEBOUNCE_MS)
    },
    [performSearch],
  )

  const loadMore = useCallback(() => {
    if (!pagination || !pagination.hasMore || isSearching) return
    const trimmed = currentQueryRef.current
    if (trimmed.length < MIN_QUERY_LENGTH) return
    performSearch(trimmed, pagination.offset + pagination.limit, true)
  }, [pagination, isSearching, performSearch])

  const clear = useCallback(() => {
    setQuery('')
    reset()
  }, [reset])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      abortRef.current?.abort()
    }
  }, [])

  return { query, results, pagination, isSearching, error, search, loadMore, clear }
}
