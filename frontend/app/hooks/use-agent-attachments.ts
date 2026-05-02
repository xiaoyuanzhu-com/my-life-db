/**
 * useAgentAttachments — composer-local state for staged attachments.
 *
 * Each Attachment goes through: uploading → ready | error. The hook owns
 * the XHR lifecycle (including abort on remove) and fires a server-side
 * DELETE when a chip is removed or the hook unmounts with pending chips.
 *
 * Storage scoping:
 *   - For an EXISTING session, the caller passes `initialStorageId` so every
 *     upload (including across multiple turns) lands in the same per-session
 *     folder. clear() resets back to that id rather than null.
 *   - For a NEW draft (no `initialStorageId`), the first upload mints a
 *     storageId from the backend; subsequent uploads in the same draft
 *     reuse it; clear() resets to null so the next draft starts fresh.
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

export function useAgentAttachments(opts: { initialStorageId?: string | null } = {}) {
  const initial = opts.initialStorageId ?? null
  const [items, setItems] = useState<StagedAttachment[]>([])
  const [storageId, setStorageId] = useState<string | null>(initial)
  const storageIdRef = useRef<string | null>(initial)
  storageIdRef.current = storageId
  const abortersRef = useRef(new Map<string, AbortController>())
  const itemsRef = useRef<StagedAttachment[]>([])
  itemsRef.current = items

  // Sync storageId when the caller switches sessions without remounting.
  // Skipped if the same instance is just transitioning between turns within
  // the same session (initial unchanged).
  useEffect(() => {
    setStorageId(initial)
    storageIdRef.current = initial
  }, [initial])

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
        const attachment = await uploadAgentAttachment(file, {
          storageId: storageIdRef.current ?? undefined,
          onProgress: (pct) => {
            setItems((prev) =>
              prev.map((it) =>
                it.clientID === clientID && it.state.status === "uploading"
                  ? { ...it, state: { ...it.state, progress: pct } }
                  : it,
              ),
            )
          },
          signal: ac.signal,
        })
        // First upload in this draft mints the storageId; lock it in for
        // subsequent uploads + for the session-create POST.
        if (storageIdRef.current === null) {
          storageIdRef.current = attachment.storageId
          setStorageId(attachment.storageId)
        }
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

  /**
   * Insert already-uploaded Attachment records as ready chips, skipping the
   * upload pipeline entirely. Used by the native iOS bridge: Swift presents
   * the document picker and POSTs the files itself, then hands back the
   * resulting Attachment records here.
   *
   * The first attachment locks in the storageId for this draft if none is
   * set, mirroring the addFiles() upload path so subsequent (web-side)
   * uploads in the same draft land in the same folder.
   */
  const addReadyAttachments = useCallback((newAttachments: Attachment[]) => {
    if (newAttachments.length === 0) return
    if (storageIdRef.current === null && newAttachments[0]) {
      storageIdRef.current = newAttachments[0].storageId
      setStorageId(newAttachments[0].storageId)
    }
    setItems((prev) => [
      ...prev,
      ...newAttachments.map((attachment) => {
        const clientID =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`
        return {
          clientID,
          state: { status: "ready", attachment } as AttachmentState,
        }
      }),
    ])
  }, [])

  const remove = useCallback(async (clientID: string) => {
    const ac = abortersRef.current.get(clientID)
    ac?.abort()
    abortersRef.current.delete(clientID)

    let toDelete: { storageId: string; filename: string } | undefined
    setItems((prev) => {
      const it = prev.find((i) => i.clientID === clientID)
      if (it?.state.status === "ready") {
        toDelete = {
          storageId: it.state.attachment.storageId,
          filename: it.state.attachment.filename,
        }
      }
      return prev.filter((i) => i.clientID !== clientID)
    })
    if (toDelete) {
      try {
        await deleteAgentAttachment(toDelete.storageId, toDelete.filename)
      } catch (e) {
        console.warn("[agent-attachments] delete on remove failed", e)
      }
    }
  }, [])

  /** Called by the composer after a successful send to clear the strip. */
  const clear = useCallback(() => {
    // Don't call DELETE — these files were just sent to the agent.
    abortersRef.current.forEach((ac) => ac.abort())
    abortersRef.current.clear()
    setItems([])
    // Reset to the caller-provided id (existing session) or null (new draft).
    // Existing-session storageId stays stable across turns so every upload
    // lands in the session's single storage folder.
    storageIdRef.current = initial
    setStorageId(initial)
  }, [initial])

  /** Ready attachments, in order — used by the composer on send. */
  const readyAttachments = items.flatMap((it) =>
    it.state.status === "ready" ? [it.state.attachment] : [],
  )
  const hasPending = items.some((it) => it.state.status !== "ready")

  // Best-effort cleanup on unmount: abort in-flight uploads and DELETE any
  // staged-but-not-sent attachments so we don't leak tmp files when the
  // user navigates away with chips still in the strip.
  useEffect(() => {
    const aborters = abortersRef
    const itemsR = itemsRef
    return () => {
      aborters.current.forEach((ac) => ac.abort())
      for (const it of itemsR.current) {
        if (it.state.status === "ready") {
          deleteAgentAttachment(
            it.state.attachment.storageId,
            it.state.attachment.filename,
          ).catch(() => {})
        }
      }
    }
  }, [])

  return { items, readyAttachments, storageId, hasPending, addFiles, addReadyAttachments, remove, clear }
}
