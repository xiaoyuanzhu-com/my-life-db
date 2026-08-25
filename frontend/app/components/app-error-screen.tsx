/**
 * AppErrorScreen — what the user sees when a render throws.
 *
 * Replaces React Router's built-in "Unexpected Application Error!" page,
 * which prints `error.message` and `error.stack` raw. On a phone that meant
 * a wall of `Nl@https://…/main-abc.js` with the actual message scrolled off
 * the top — literally unreadable.
 *
 * This screen is deliberately dependency-light (no Radix, no shadcn) so it
 * can't fail for the same reason the app just did. It leads with the decoded
 * message, then update-loop diagnostics, then the stacks — each collapsed
 * behind a `<details>` so the important part stays on screen. Everything is
 * one tap away from the clipboard, because the person reading it is on a
 * phone and can't open devtools.
 */

import { useMemo, useState } from 'react'
import { isRouteErrorResponse, useRouteError } from 'react-router'
import { useTranslation } from 'react-i18next'
import { buildErrorReport } from '~/lib/error-report'

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        // iOS WKWebView without clipboard permission — fall back to a
        // throwaway textarea + execCommand.
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground active:opacity-70"
    >
      {copied ? t('errorBoundary.copied', 'Copied') : t('errorBoundary.copyDetails', 'Copy details')}
    </button>
  )
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <details className="rounded-md border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-foreground">
        {title}
      </summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <code>{body}</code>
      </pre>
    </details>
  )
}

export function AppErrorScreen({ error }: { error: unknown }) {
  const { t } = useTranslation('common')

  // 404s and other route responses aren't crashes — keep the old, calm UI.
  const routeResponse = isRouteErrorResponse(error) ? error : null

  const report = useMemo(
    () => (routeResponse ? null : buildErrorReport(error)),
    [error, routeResponse],
  )

  if (routeResponse) {
    const isNotFound = routeResponse.status === 404
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="space-y-3 text-center">
          <h1 className="text-4xl font-bold">
            {isNotFound ? t('errorBoundary.notFoundTitle', '404') : String(routeResponse.status)}
          </h1>
          <p className="text-muted-foreground">
            {isNotFound
              ? t('errorBoundary.notFoundDetails', 'The requested page could not be found.')
              : routeResponse.statusText || t('errorBoundary.generic', 'An unexpected error occurred.')}
          </p>
        </div>
      </main>
    )
  }

  if (!report) return null

  return (
    <main className="min-h-dvh overflow-y-auto bg-background p-4 pb-16">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-foreground">
            {t('errorBoundary.oops', 'Oops!')}
          </h1>
          {/* The decoded message, at readable size, wrapped — this is the
              line that was missing before. */}
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">
            {report.headline}
          </p>
          {report.hint && (
            <p className="whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {report.hint}
            </p>
          )}
          {report.reactCode && (
            <p className="text-xs text-muted-foreground">
              React #{report.reactCode} ·{' '}
              <a className="underline" href={report.reactUrl ?? undefined} target="_blank" rel="noreferrer">
                react.dev/errors/{report.reactCode}
              </a>
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground active:opacity-70"
          >
            {t('errorBoundary.reload', 'Reload')}
          </button>
          <CopyButton text={report.text} />
        </div>

        <div className="flex flex-col gap-2">
          <Section
            title={t('errorBoundary.diagnostics', 'Update-loop diagnostics')}
            body={report.diagnostics}
          />
          {report.componentStack && (
            <Section
              title={t('errorBoundary.componentStack', 'Component stack')}
              body={report.componentStack.trim()}
            />
          )}
          {report.reactCode && (
            <Section title={t('errorBoundary.rawMessage', 'Raw message')} body={report.rawMessage} />
          )}
          {report.stack && (
            <Section title={t('errorBoundary.stack', 'Stack')} body={report.stack} />
          )}
        </div>
      </div>
    </main>
  )
}

/** Route-level boundary: reads the error React Router caught. */
export function AppRouteErrorBoundary() {
  const error = useRouteError()
  return <AppErrorScreen error={error} />
}
