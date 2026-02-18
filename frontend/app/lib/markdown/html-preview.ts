// Placeholder pattern for HTML preview blocks
export const HTML_PREVIEW_PLACEHOLDER_PREFIX = '___HTML_PREVIEW_BLOCK_'
export const HTML_PREVIEW_PLACEHOLDER_SUFFIX = '___'
export const HTML_PREVIEW_PLACEHOLDER_REGEX = new RegExp(
  `${HTML_PREVIEW_PLACEHOLDER_PREFIX}(\\d+)${HTML_PREVIEW_PLACEHOLDER_SUFFIX}`,
  'g'
)

// Expand button SVG — Lucide "maximize-2" icon
const EXPAND_BTN_HTML = `<button class="preview-expand-btn" aria-label="Expand preview" title="Expand preview"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>`

export function renderHtmlPreviewBlock(code: string): string {
  const escapedHtml = code.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return `<div class="html-preview-container">${EXPAND_BTN_HTML}<iframe srcdoc="${escapedHtml}" sandbox="allow-scripts" class="html-preview-iframe"></iframe></div>`
}

export function getHtmlPreviewLoadingHtml(): string {
  return '<div class="html-preview-loading"><span class="text-muted-foreground text-sm">Loading preview...</span></div>'
}
