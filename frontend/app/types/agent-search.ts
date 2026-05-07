export interface AgentSessionSearchResult {
  sessionId: string
  title: string
  snippet: string
  score: number
  updatedAt: number
  agentType: string
}

export interface AgentSessionSearchPagination {
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface AgentSessionSearchResponse {
  results: AgentSessionSearchResult[]
  pagination: AgentSessionSearchPagination
  query: string
}
