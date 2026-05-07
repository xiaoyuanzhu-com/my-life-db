/**
 * draft-outbox — structured logger.
 *
 * Every state transition in the outbox emits a log line tagged with
 * "[draft-outbox]". When a user reports lost input, these lines alone
 * should explain what happened.
 */

const TAG = "[draft-outbox]"

export interface LogFields {
  [key: string]: unknown
}

function fmt(fields?: LogFields): string {
  if (!fields) return ""
  const parts: string[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    if (typeof v === "string") parts.push(`${k}=${v}`)
    else parts.push(`${k}=${JSON.stringify(v)}`)
  }
  return parts.length ? " " + parts.join(" ") : ""
}

export const logger = {
  info(msg: string, fields?: LogFields): void {
    console.info(`${TAG} ${msg}${fmt(fields)}`)
  },
  warn(msg: string, fields?: LogFields): void {
    console.warn(`${TAG} ${msg}${fmt(fields)}`)
  },
  error(msg: string, fields?: LogFields): void {
    console.error(`${TAG} ${msg}${fmt(fields)}`)
  },
}
