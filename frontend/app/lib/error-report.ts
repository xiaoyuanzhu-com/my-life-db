/**
 * error-report — turn a caught error into something a human can read on a
 * phone.
 *
 * Two problems this solves:
 *
 * 1. **Minified React errors.** In a production bundle React replaces its
 *    messages with `Minified React error #185; visit https://react.dev/…`.
 *    The number is the only signal, and it's the part users skim past. We
 *    decode the codes we can actually hit into their real text.
 *
 * 2. **Useless stacks.** Minified frames (`Nl@https://…/main-abc.js`) name
 *    nothing. React's `componentStack` is better but arrives via
 *    `onUncaughtError` / `componentDidCatch`, not through React Router's
 *    error boundary props — so we stash it here when React hands it to us
 *    and pair it back up with the error later.
 */

import { formatProbeSnapshot, getProbeSnapshot } from './diagnostics/update-probe'

/**
 * React's production error codes, for the subset a client-rendered SPA can
 * realistically hit. `%s` placeholders are filled from the `args[]` query
 * params React puts in the react.dev link.
 *
 * Source: react/scripts/error-codes/codes.json (not shipped in the npm
 * package, so this is a hand-picked copy). An unknown code degrades to the
 * react.dev link, which is exactly what we have today.
 */
const REACT_ERROR_MESSAGES: Record<string, string> = {
  '31': 'Objects are not valid as a React child (found: %s).',
  '130': 'Element type is invalid: expected a string (for built-in components) or a class/function (for composite components) but got: %s.',
  '152': '%s.render(): A valid React element (or null) must be returned.',
  '185':
    'Maximum update depth exceeded. This can happen when a component calls setState inside useEffect, but useEffect either does not have a dependency array, or one of the dependencies changes on every render.',
  '188': 'unstable_createNodeMock: Compiled with old version of React.',
  '300': 'Rendered more hooks than during the previous render.',
  '301':
    'Too many re-renders. React limits the number of renders to prevent an infinite loop.',
  '310': 'Rendered fewer hooks than expected. This may be caused by an accidental early return statement.',
  '321':
    'Invalid hook call. Hooks can only be called inside of the body of a function component.',
  '418': 'Hydration failed because the server rendered HTML did not match the client.',
  '421': 'A component suspended while responding to synchronous input.',
  '422': 'There was an error while hydrating this Suspense boundary.',
  '423': 'There was an error while hydrating.',
  '425': 'Text content does not match server-rendered HTML.',
  '426': 'A component was suspended by an uncached promise.',
  '482': 'A function was passed to the Client but it is not a Server Function.',
}

/**
 * Extra context we can offer for codes where the generic React text still
 * doesn't tell you what to do next. Shown under the decoded message.
 */
const REACT_ERROR_HINTS: Record<string, string> = {
  '185':
    'React aborts after 50 consecutive commits that each leave another update pending. Look at "update-loop diagnostics" below: the site with the highest peak is the one spinning.',
  '300': 'A hook was called conditionally, or a component changed identity between renders.',
  '301': 'A component is calling setState directly during render.',
  '310': 'An early `return` before a hook call — check for a guard added above a hook.',
}

export interface DecodedReactError {
  code: string
  /** Decoded message with args substituted, or null if the code is unknown. */
  message: string | null
  /** Extra guidance for this code, if we have any. */
  hint: string | null
  /** Canonical react.dev link, always present. */
  url: string
}

const MINIFIED_RE = /Minified React error #(\d+)/

/**
 * Decode `Minified React error #NNN; visit https://react.dev/errors/NNN?args[]=…`
 * into readable text. Returns null when `message` isn't a minified React error.
 */
export function decodeReactError(message: string): DecodedReactError | null {
  const match = MINIFIED_RE.exec(message)
  if (!match) return null
  const code = match[1]

  // Pull args[] out of the react.dev URL React embedded in the message.
  const args: string[] = []
  const urlMatch = /https?:\/\/react\.dev\/errors\/\d+(\?[^\s]*)?/.exec(message)
  if (urlMatch?.[1]) {
    try {
      const params = new URLSearchParams(urlMatch[1].slice(1))
      for (const value of params.getAll('args[]')) args.push(value)
    } catch {
      // Malformed query string — decode without args.
    }
  }

  const template = REACT_ERROR_MESSAGES[code]
  let decoded: string | null = null
  if (template) {
    let i = 0
    decoded = template.replace(/%s/g, () => args[i++] ?? '%s')
  }

  return {
    code,
    message: decoded,
    hint: REACT_ERROR_HINTS[code] ?? null,
    url: `https://react.dev/errors/${code}`,
  }
}

// ── Component-stack capture ──────────────────────────────────────────────
//
// React hands `componentStack` to createRoot's onUncaughtError/onCaughtError
// callbacks. React Router's error boundary only receives the error object, so
// we park the most recent pairing here and look it up by error identity.

interface CapturedInfo {
  error: unknown
  componentStack: string
  at: number
}

let lastCaptured: CapturedInfo | null = null

/** Called from createRoot's error callbacks. */
export function captureComponentStack(error: unknown, componentStack: string | null | undefined): void {
  if (!componentStack) return
  lastCaptured = { error, componentStack, at: Date.now() }
}

/**
 * Component stack for `error`, if React gave us one. Falls back to the most
 * recent capture within 5s — React Router re-throws through its own boundary,
 * and in some paths the identity we see is a wrapper, not the original.
 */
export function getComponentStack(error: unknown): string | null {
  if (!lastCaptured) return null
  if (lastCaptured.error === error) return lastCaptured.componentStack
  if (Date.now() - lastCaptured.at < 5_000) return lastCaptured.componentStack
  return null
}

// ── Report formatting ────────────────────────────────────────────────────

export interface ErrorReport {
  /** Short, human headline — decoded React text when we have it. */
  headline: string
  /** Extra guidance, if any. */
  hint: string | null
  /** The raw `error.message`, always kept — decoding is additive. */
  rawMessage: string
  /** React error code, when this was a minified React error. */
  reactCode: string | null
  reactUrl: string | null
  componentStack: string | null
  stack: string | null
  /** Rendered update-loop probe counters. */
  diagnostics: string
  /** Everything above as one copy-pasteable block. */
  text: string
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const maybe = (error as { message?: unknown }).message
    if (typeof maybe === 'string') return maybe
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

/** Build the full report shown by the error screen and copied to clipboard. */
export function buildErrorReport(error: unknown): ErrorReport {
  const rawMessage = errorMessageOf(error)
  const decoded = decodeReactError(rawMessage)
  const componentStack = getComponentStack(error)
  const stack = error instanceof Error ? (error.stack ?? null) : null
  const diagnostics = formatProbeSnapshot(getProbeSnapshot())

  const headline = decoded?.message ?? rawMessage
  const name = error instanceof Error ? error.name : 'Error'

  const parts: string[] = [
    `${name}: ${rawMessage}`,
  ]
  if (decoded?.message) parts.push(`\nDecoded (React #${decoded.code}):\n${decoded.message}`)
  if (decoded?.hint) parts.push(`\nHint:\n${decoded.hint}`)
  parts.push(`\nURL: ${typeof location !== 'undefined' ? location.href : '(unknown)'}`)
  parts.push(`When: ${new Date().toISOString()}`)
  if (typeof navigator !== 'undefined') parts.push(`UA: ${navigator.userAgent}`)
  parts.push(`\nUpdate-loop diagnostics:\n${diagnostics}`)
  if (componentStack) parts.push(`\nComponent stack:${componentStack}`)
  if (stack) parts.push(`\nStack:\n${stack}`)

  return {
    headline,
    hint: decoded?.hint ?? null,
    rawMessage,
    reactCode: decoded?.code ?? null,
    reactUrl: decoded?.url ?? null,
    componentStack,
    stack,
    diagnostics,
    text: parts.join('\n'),
  }
}
