// Placeholder pattern for HTML preview blocks
export const HTML_PREVIEW_PLACEHOLDER_PREFIX = '___HTML_PREVIEW_BLOCK_'
export const HTML_PREVIEW_PLACEHOLDER_SUFFIX = '___'
export const HTML_PREVIEW_PLACEHOLDER_REGEX = new RegExp(
  `${HTML_PREVIEW_PLACEHOLDER_PREFIX}(\\d+)${HTML_PREVIEW_PLACEHOLDER_SUFFIX}`,
  'g'
)

export function renderHtmlPreviewBlock(code: string): string {
  const escapedHtml = code.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return `<div class="html-preview-container"><iframe srcdoc="${escapedHtml}" sandbox="allow-scripts" class="html-preview-iframe"></iframe></div>`
}

export function getHtmlPreviewLoadingHtml(): string {
  return '<div class="html-preview-loading"><span class="text-muted-foreground text-sm">Loading preview...</span></div>'
}
