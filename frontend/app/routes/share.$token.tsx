import { useState, useEffect } from 'react'
import { useParams } from 'react-router'

interface ShareMetadata {
  id: string
  title: string
  agentType: string
  createdAt: number
}

export default function SharePage() {
  const { token } = useParams()
  const [metadata, setMetadata] = useState<ShareMetadata | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch session metadata
  useEffect(() => {
    if (!token) return

    fetch(`/api/agent/share/${token}`)
      .then(async (res) => {
        if (res.status === 404) {
          setError('This shared session is no longer available.')
          setLoading(false)
          return
        }
        if (!res.ok) {
          setError(`Failed to load shared session (${res.status}).`)
          setLoading(false)
          return
        }
        const data = await res.json()
        setMetadata(data)
        setLoading(false)
      })
      .catch(() => {
        setError('Failed to load shared session.')
        setLoading(false)
      })
  }, [token])

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-foreground">
        <p className="text-muted-foreground">Loading shared session...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-foreground">
        <p className="text-destructive">{error}</p>
      </div>
    )
  }

  const title = metadata?.title || 'Shared Session'

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
          Shared session
        </span>
      </div>
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">Shared session viewer coming soon.</p>
      </div>
    </div>
  )
}
