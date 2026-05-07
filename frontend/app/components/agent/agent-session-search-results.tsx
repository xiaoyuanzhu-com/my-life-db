import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2Icon } from 'lucide-react'
import { cn } from '~/lib/utils'
import { useFormatter } from '~/lib/i18n/use-formatter'
import type { UseAgentSessionSearch } from '~/hooks/use-agent-session-search'
import type { AgentSessionSearchResult } from '~/types/agent-search'

type SnippetPart = { text: string; highlight: boolean }

// Backend emits ONLY literal `<em>` and `</em>` markers around matched terms.
// Surrounding text is untrusted user content — never feed `snippet` into
// dangerouslySetInnerHTML. This parser splits on the literal tags and lets
// React render each fragment as plain text, with matches wrapped in <mark>.
function parseSnippet(raw: string): SnippetPart[] {
  const out: SnippetPart[] = []
  let rest = raw
  while (rest.length > 0) {
    const open = rest.indexOf('<em>')
    if (open === -1) {
      out.push({ text: rest, highlight: false })
      break
    }
    if (open > 0) out.push({ text: rest.slice(0, open), highlight: false })
    const close = rest.indexOf('</em>', open + 4)
    if (close === -1) {
      out.push({ text: rest.slice(open + 4), highlight: false })
      break
    }
    out.push({ text: rest.slice(open + 4, close), highlight: true })
    rest = rest.slice(close + 5)
  }
  return out
}

interface SearchResultRowProps {
  result: AgentSessionSearchResult
  isActive: boolean
  onSelect: (sessionId: string) => void
}

const SearchResultRow: FC<SearchResultRowProps> = ({ result, isActive, onSelect }) => {
  const f = useFormatter()
  const parts = parseSnippet(result.snippet)
  return (
    <button
      type="button"
      data-active={isActive || undefined}
      onClick={() => onSelect(result.sessionId)}
      className={cn(
        'group flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none data-active:bg-muted',
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className="flex-1 truncate text-[13px] text-foreground/80">
          {result.title}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground/60">
          {f.relative(result.updatedAt)}
        </span>
      </div>
      <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
        {parts.map((part, i) =>
          part.highlight ? (
            <mark
              key={i}
              className="rounded-sm bg-yellow-200/70 px-0.5 text-foreground dark:bg-yellow-800/50"
            >
              {part.text}
            </mark>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
      </span>
    </button>
  )
}

interface AgentSessionSearchResultsProps {
  state: UseAgentSessionSearch
  activeSessionId: string | null
  onSelect: (sessionId: string) => void
}

export const AgentSessionSearchResults: FC<AgentSessionSearchResultsProps> = ({
  state,
  activeSessionId,
  onSelect,
}) => {
  const { t } = useTranslation('agent')
  const { results, isSearching, error, pagination, loadMore } = state

  if (isSearching && results.length === 0) {
    return (
      <div className="px-2.5 py-2 text-sm text-muted-foreground">
        {t('sidebar.search.loading')}
      </div>
    )
  }

  if (error && results.length === 0) {
    return (
      <div className="px-2.5 py-2 text-sm text-muted-foreground">
        {t('sidebar.search.error')}
      </div>
    )
  }

  if (!isSearching && results.length === 0) {
    return (
      <div className="px-2.5 py-2 text-sm text-muted-foreground">
        {t('sidebar.search.noResults')}
      </div>
    )
  }

  return (
    <div className="aui-root flex flex-1 min-h-0 flex-col gap-0.5 overflow-y-auto">
      {results.map((r) => (
        <SearchResultRow
          key={r.sessionId}
          result={r}
          isActive={r.sessionId === activeSessionId}
          onSelect={onSelect}
        />
      ))}
      {pagination?.hasMore && (
        <div className="flex items-center justify-center py-2">
          {isSearching ? (
            <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <button
              type="button"
              onClick={loadMore}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {t('sidebar.search.loadMore')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
