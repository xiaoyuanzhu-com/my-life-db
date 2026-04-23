/**
 * Client for the agent-session attachment API.
 *
 * Attachments are ephemeral files staged server-side under
 * APP_DATA_DIR/tmp/agent-uploads/<uploadID>/. They are referenced in the
 * outgoing prompt via `@<absolutePath>` (the same convention as the
 * existing @-file-tag). A server-side janitor deletes staged files older
 * than 30 days.
 */

import { fetchWithRefresh } from "~/lib/fetch-with-refresh"

export interface Attachment {
  uploadID: string
  absolutePath: string
  filename: string
  size: number
  contentType?: string
}

export async function uploadAgentAttachment(
  file: File,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<Attachment> {
  // fetch() doesn't expose upload progress, so use XHR when a progress
  // callback is needed. Falls back to fetchWithRefresh for the no-progress
  // case (keeps auth refresh behavior consistent).
  if (!onProgress) {
    const fd = new FormData()
    fd.append("file", file)
    const res = await fetchWithRefresh("/api/agent/attachments", {
      method: "POST",
      body: fd,
      signal,
    })
    if (!res.ok) throw new Error(`upload failed: ${res.status}`)
    return res.json()
  }

  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", "/api/agent/attachments")
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
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
    signal?.addEventListener("abort", () => xhr.abort())
    const fd = new FormData()
    fd.append("file", file)
    xhr.send(fd)
  })
}

export async function deleteAgentAttachment(uploadID: string): Promise<void> {
  const res = await fetchWithRefresh(
    `/api/agent/attachments/${encodeURIComponent(uploadID)}`,
    { method: "DELETE" },
  )
  if (!res.ok && res.status !== 204) throw new Error(`delete failed: ${res.status}`)
}
