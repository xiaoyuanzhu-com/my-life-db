import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Check, Copy, Loader2, Play, Save, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { api } from '~/lib/api'

interface AutoAgentPayload {
  name: string
  agent?: string
  trigger?: string
  schedule?: string
  path?: string
  enabled?: boolean
  markdown?: string
  prompt?: string
  parseError?: string
}

interface Props {
  name: string
  onSaved: (name: string) => void
  onDeleted: () => void
  onEditWithAI: (name: string, markdown: string) => void
  onBack?: () => void
}

export function AutoAgentEditor({ name, onSaved, onDeleted, onEditWithAI, onBack }: Props) {
  const [markdown, setMarkdown] = useState('')
  const [originalMarkdown, setOriginalMarkdown] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        setLoading(true)
        setError(null)
        const res = await api.get(`/api/agent/defs/${encodeURIComponent(name)}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: AutoAgentPayload = await res.json()
        if (cancelled) return
        const md = data.markdown ?? ''
        setMarkdown(md)
        setOriginalMarkdown(md)
        if (data.parseError) setError(data.parseError)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [name])

  const dirty = markdown !== originalMarkdown

  const handleSave = useCallback(async () => {
    try {
      setSaving(true)
      setError(null)
      const res = await api.put(
        `/api/agent/defs/${encodeURIComponent(name)}`,
        { markdown }
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setOriginalMarkdown(markdown)
      onSaved(name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }, [name, markdown, onSaved])

  const handleRun = useCallback(async () => {
    try {
      setRunning(true)
      setError(null)
      const res = await api.post(`/api/agent/defs/${encodeURIComponent(name)}/run`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run')
    } finally {
      setRunning(false)
    }
  }, [name])

  const handleDelete = useCallback(async () => {
    try {
      const res = await api.delete(`/api/agent/defs/${encodeURIComponent(name)}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setDeleteOpen(false)
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    }
  }, [name, onDeleted])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(markdown)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [markdown])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        {onBack && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onBack}
            title="Back to agents"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <div className="flex-1 truncate text-sm font-semibold">{name}</div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => onEditWithAI(name, markdown)}
            title="Open a new chat session pre-filled with a prompt to edit this agent"
          >
            <Sparkles className="h-4 w-4" />
            Edit with AI
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            onClick={handleRun}
            disabled={running || dirty}
            title={dirty ? 'Save before running' : 'Trigger this agent once now'}
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run now
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setShareOpen(true)}
          >
            <Copy className="h-4 w-4" />
            Share
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
          <Button
            variant="default"
            size="sm"
            className="h-8 gap-1.5"
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 min-h-0 p-3">
        <Textarea
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          spellCheck={false}
          className="h-full w-full resize-none font-mono text-sm leading-relaxed"
          placeholder="---&#10;agent: claude_code&#10;trigger: manual&#10;---&#10;&#10;Prompt body…"
        />
      </div>

      {/* Delete confirm */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete auto agent?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the <span className="font-mono">{name}</span> folder from disk.
              Past sessions it spawned are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Share as text */}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Share as text</DialogTitle>
            <DialogDescription>
              Copy the full markdown definition. Paste into another MyLifeDB instance at{' '}
              <span className="font-mono">agents/{name}/{name}.md</span>.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={markdown}
            readOnly
            spellCheck={false}
            className="h-64 w-full resize-none font-mono text-xs"
          />
          <Button onClick={handleCopy} className="ml-auto gap-1.5">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
