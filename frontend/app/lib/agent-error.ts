interface AgentErrorLike {
  message?: unknown
  data?: unknown
}

const GENERIC_ERROR_MESSAGES = new Set([
  "agent error",
  "internal error",
  "request failed",
  "unknown error",
])

function cleanMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const message = value.trim()
  return message || undefined
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function findJsonEnd(value: string, start: number): number {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let i = start; i < value.length; i++) {
    const char = value[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === "{" || char === "[") {
      stack.push(char)
    } else if (char === "}" || char === "]") {
      const opener = stack.pop()
      if (
        (char === "}" && opener !== "{") ||
        (char === "]" && opener !== "[")
      ) {
        return -1
      }
      if (stack.length === 0) return i
    }
  }

  return -1
}

function parseJson(value: string): unknown | undefined {
  const direct = tryParseJson(value)
  if (direct !== undefined) return direct

  const objectStart = value.indexOf("{")
  const arrayStart = value.indexOf("[")
  const starts = [objectStart, arrayStart]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)

  for (const start of starts) {
    const end = findJsonEnd(value, start)
    if (end < 0) continue

    const parsed = tryParseJson(value.slice(start, end + 1))
    if (parsed !== undefined) return parsed
  }

  return undefined
}

function extractNestedMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 12) return undefined

  if (typeof value === "string") {
    const message = cleanMessage(value)
    if (!message) return undefined

    const parsed = parseJson(message)
    return parsed === undefined
      ? message
      : extractNestedMessage(parsed, depth + 1)
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractNestedMessage(item, depth + 1)
      if (message) return message
    }
    return undefined
  }

  if (typeof value !== "object" || value === null) return undefined

  const record = value as Record<string, unknown>
  for (const key of ["data", "error", "raw", "cause"]) {
    const message = extractNestedMessage(record[key], depth + 1)
    if (message) return message
  }

  return extractNestedMessage(record.message, depth + 1)
}

/**
 * Prefer the actionable provider message embedded in ACP error diagnostics.
 * Older Codex frames stored it in data.raw while exposing only
 * "Internal error" at the top level.
 */
export function formatAgentErrorMessage(frame: AgentErrorLike): string {
  const fallback = cleanMessage(frame.message) ?? "Unknown error"
  if (!GENERIC_ERROR_MESSAGES.has(fallback.toLowerCase())) return fallback

  return extractNestedMessage(frame.data) ?? fallback
}
