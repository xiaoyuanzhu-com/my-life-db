import { useState, useEffect, useRef, useCallback, type FC, type ReactNode } from "react"
import { Popover, PopoverTrigger, PopoverContent } from "~/components/ui/popover"
import { api } from "~/lib/api"
import { Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"

interface TurnSummary {
  turnNumber: number
  question: string
  stopReason?: string
}

interface SessionTurnsPopoverProps {
  sessionId: string
  onNavigate: (turnNumber: number) => void
  disabled?: boolean
  children: ReactNode
}

export const SessionTurnsPopover: FC<SessionTurnsPopoverProps> = ({
  sessionId,
  onNavigate,
  disabled = false,
  children,
}) => {
  const { t } = useTranslation("agent")
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<TurnSummary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled

  const clearTimers = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
  }, [])

  // Cancel in-flight fetch on unmount
  useEffect(() => {
    return () => {
      clearTimers()
      abortRef.current?.abort()
    }
  }, [clearTimers])

  // Fetch turns when popover opens
  useEffect(() => {
    if (!open || turns !== null) return

    setLoading(true)
    setError(null)
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    api
      .get(`/api/agent/sessions/${sessionId}/turns`, { signal: controller.signal })
      .then((res) => res.json())
      .then((data) => {
        if (!controller.signal.aborted) {
          setTurns(data.turns ?? [])
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err.message ?? "Failed to load turns")
          setLoading(false)
        }
      })

    return () => controller.abort()
  }, [open, sessionId, turns])

  // Reset state when sessionId changes (new hover target)
  useEffect(() => {
    setTurns(null)
    setError(null)
  }, [sessionId])

  // Close popover when the three-dot menu opens (prevents flicker fight)
  useEffect(() => {
    if (disabled && open) {
      clearTimers()
      setOpen(false)
    }
  }, [disabled, open, clearTimers])

  const handleMouseEnter = useCallback(() => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
    if (disabled) return
    if (!open && !hoverTimerRef.current) {
      hoverTimerRef.current = setTimeout(() => {
        hoverTimerRef.current = null
        if (!disabledRef.current) setOpen(true)
      }, 400)
    }
  }, [open, disabled])

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    if (open && !leaveTimerRef.current) {
      leaveTimerRef.current = setTimeout(() => {
        leaveTimerRef.current = null
        setOpen(false)
      }, 200)
    }
  }, [open])

  const handlePopoverEnter = useCallback(() => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
  }, [])

  const handlePopoverLeave = useCallback(() => {
    if (!leaveTimerRef.current) {
      leaveTimerRef.current = setTimeout(() => {
        leaveTimerRef.current = null
        setOpen(false)
      }, 200)
    }
  }, [])

  const handleNavigate = useCallback(
    (turnNumber: number) => {
      onNavigate(turnNumber)
      setOpen(false)
    },
    [onNavigate],
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
        {children}
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-64 max-h-80 overflow-y-auto p-1"
        onMouseEnter={handlePopoverEnter}
        onMouseLeave={handlePopoverLeave}
      >
        {loading && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {t("sidebar.turns.loadError", "Failed to load turns")}
          </p>
        )}
        {!loading && !error && turns !== null && turns.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {t("sidebar.turns.noTurns", "No turns yet")}
          </p>
        )}
        {!loading && !error && turns !== null && turns.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {turns.map((turn) => (
              <button
                key={turn.turnNumber}
                type="button"
                onClick={() => handleNavigate(turn.turnNumber)}
                className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
              >
                <span className="mt-0.5 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  #{turn.turnNumber}
                </span>
                <span className="line-clamp-2 min-w-0 flex-1">{turn.question}</span>
                {!turn.stopReason && (
                  <span className="mt-0.5 shrink-0 rounded bg-amber-500/15 px-1 py-px font-mono text-[9px] text-amber-400">
                    {t("sidebar.turns.active", "Active")}
                  </span>
                )}
                {turn.stopReason && turn.stopReason !== "end_turn" && (
                  <span className="mt-0.5 shrink-0 rounded bg-muted px-1 py-px font-mono text-[9px] text-muted-foreground">
                    {turn.stopReason}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
