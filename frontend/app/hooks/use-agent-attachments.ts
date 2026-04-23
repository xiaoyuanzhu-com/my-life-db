/**
 * useAgentAttachments — composer-local state for staged attachments.
 *
 * Each Attachment goes through: uploading → ready | error. The hook owns
 * the XHR lifecycle (including abort on remove) and fires a server-side
 * DELETE when a chip is removed or the hook unmounts with pending chips.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  uploadAgentAttachment,
  deleteAgentAttachment,
  type Attachment,
} from "~/lib/agent-attachments"

export type AttachmentState =
  | { status: "uploading"; progress: number; file: File }
  | { status: "ready"; attachment: Attachment }
  | { status: "error"; error: string; file: File }

export interface StagedAttachment {
  /** Client-side id, stable across state transitions. */
  clientID: string
  state: AttachmentState
}

export function useAgentAttachments() {
  const [items, setItems] = useState<StagedAttachment[]>([])
  const abortersRef = useRef(new Map<string, AbortController>())
  const itemsRef = useRef<StagedAttachment[]>([])
  itemsRef.current = items

  const addFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      const clientID =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      setItems((prev) => [
        ...prev,
        { clientID, state: { status: "uploading", progress: 0, file } },
      ])
      const ac = new AbortController()
      abortersRef.current.set(clientID, ac)

      try {
        const attachment = await uploadAgentAttachment(
          file,
          (pct) => {
            setItems((prev) =>
              prev.map((it) =>
                it.clientID === clientID && it.state.status === "uploading"
                  ? { ...it, state: { ...it.state, progress: pct } }
                  : it,
              ),
            )
          },
          ac.signal,
        )
        setItems((prev) =>
          prev.map((it) =>
            it.clientID === clientID
              ? { clientID, state: { status: "ready", attachment } }
              : it,
          ),
        )
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return
        setItems((prev) =>
          prev.map((it) =>
            it.clientID === clientID
              ? { clientID, state: { status: "error", error: String(err), file } }
              : it,
          ),
        )
      } finally {
        abortersRef.current.delete(clientID)
      }
    }
  }, [])

  const remove = useCallback(async (clientID: string) => {
    const ac = abortersRef.current.get(clientID)
    ac?.abort()
    abortersRef.current.delete(clientID)

    let uploadID: string | undefined
    setItems((prev) => {
      const it = prev.find((i) => i.clientID === clientID)
      if (it?.state.status === "ready") uploadID = it.state.attachment.uploadID
      return prev.filter((i) => i.clientID !== clientID)
    })
    if (uploadID) {
      try {
        await deleteAgentAttachment(uploadID)
      } catch (e) {
        console.warn("[agent-attachments] delete on remove failed", e)
      }
    }
  }, [])

  /** Called by the composer after a successful send to clear the strip. */
  const clear = useCallback(() => {
    // Don't call DELETE — these files were just sent to the agent and may
    // still be referenced. The 30-day janitor will clean up.
    abortersRef.current.forEach((ac) => ac.abort())
    abortersRef.current.clear()
    setItems([])
  }, [])

  /** Ready attachments, in order — used by the composer on send. */
  const readyAttachments = items.flatMap((it) =>
    it.state.status === "ready" ? [it.state.attachment] : [],
  )
  const hasPending = items.some((it) => it.state.status !== "ready")

  // Best-effort cleanup on unmount: abort in-flight uploads and DELETE any
  // staged-but-not-sent attachments so we don't leak tmp files when the
  // user navigates away with chips still in the strip.
  useEffect(() => {
    // Capture ref objects into locals (the lint rule warns that `.current`
    // can drift between mount and unmount — not an issue here since we
    // only instantiate these refs once, but capturing makes intent explicit).
    const aborters = abortersRef
    const itemsR = itemsRef
    return () => {
      aborters.current.forEach((ac) => ac.abort())
      for (const it of itemsR.current) {
        if (it.state.status === "ready") {
          deleteAgentAttachment(it.state.attachment.uploadID).catch(() => {})
        }
      }
    }
  }, [])

  return { items, readyAttachments, hasPending, addFiles, remove, clear }
}
