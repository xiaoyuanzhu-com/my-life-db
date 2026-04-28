/**
 * Client for the agent-session attachment API.
 *
 * Attachments are staged server-side under
 * USER_DATA_DIR/sessions/<storageId>/uploads/<filename>. They are referenced
 * in the outgoing prompt via `@<absolutePath>` (the same convention as the
 * existing @-file-tag).
 *
 * The first upload in a draft mints a fresh storageId and returns it; the
 * client passes that id back on subsequent uploads in the same draft, and on
 * POST /api/agent/sessions when the message is sent. After session create the
 * id is persisted on the agent_sessions row.
 */

import { fetchWithRefresh } from "~/lib/fetch-with-refresh"

export interface Attachment {
  storageId: string
  filename: string
  absolutePath: string
  size: number
  contentType?: string
}

export async function uploadAgentAttachment(
  file: File,
  opts?: {
    storageId?: string
    onProgress?: (pct: number) => void
    signal?: AbortSignal
  },
): Promise<Attachment> {
  // fetch() doesn't expose upload progress, so use XHR when a progress
  // callback is needed. Falls back to fetchWithRefresh for the no-progress
  // case (keeps auth refresh behavior consistent).
  if (!opts?.onProgress) {
    const fd = new FormData()
    fd.append("file", file)
    if (opts?.storageId) fd.append("storageId", opts.storageId)
    const res = await fetchWithRefresh("/api/agent/attachments", {
      method: "POST",
      body: fd,
      signal: opts?.signal,
    })
    if (!res.ok) throw new Error(`upload failed: ${res.status}`)
    return res.json()
  }

  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", "/api/agent/attachments")
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress!(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch (e) {
          reject(e)
        }
      } else {
        reject(new Error(`upload failed: ${xhr.status} ${xhr.responseText}`))
      }
    }
    xhr.onerror = () => reject(new Error("network error"))
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"))
    opts.signal?.addEventListener("abort", () => xhr.abort())
    const fd = new FormData()
    fd.append("file", file)
    if (opts.storageId) fd.append("storageId", opts.storageId)
    xhr.send(fd)
  })
}

export async function deleteAgentAttachment(
  storageId: string,
  filename: string,
): Promise<void> {
  const res = await fetchWithRefresh(
    `/api/agent/attachments/${encodeURIComponent(storageId)}/${encodeURIComponent(filename)}`,
    { method: "DELETE" },
  )
  if (!res.ok && res.status !== 204) throw new Error(`delete failed: ${res.status}`)
}
