// Placeholder pattern for HTML preview blocks
export const HTML_PREVIEW_PLACEHOLDER_PREFIX = '___HTML_PREVIEW_BLOCK_'
export const HTML_PREVIEW_PLACEHOLDER_SUFFIX = '___'
export const HTML_PREVIEW_PLACEHOLDER_REGEX = new RegExp(
  `${HTML_PREVIEW_PLACEHOLDER_PREFIX}(\\d+)${HTML_PREVIEW_PLACEHOLDER_SUFFIX}`,
  'g'
)

// Expand button SVG — Lucide "maximize-2" icon
const EXPAND_BTN_HTML = `<button class="preview-expand-btn" aria-label="Expand preview" title="Expand preview"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>`

// IMPORTANT: srcdoc encoding depends on HOW the iframe is created.
//
// This function builds an HTML string set via innerHTML (element.innerHTML = html).
// The browser's HTML parser decodes entities in attribute values before setting
// DOM properties. So the flow is:
//   innerHTML parse: srcdoc="&quot;" → DOM property: srcdoc = '"'
//   iframe loads:    '"' parsed as HTML → proper attribute delimiter
//
// Entity encoding (" → &quot;, & → &amp;) is REQUIRED here to:
//   1. Prevent " in the code from closing the srcdoc="..." attribute early
//   2. Prevent & from being consumed as an entity during innerHTML parsing
//
// Compare with markdown-text.tsx (React's srcDoc prop), which sets the DOM
// property DIRECTLY — no innerHTML parse step — so encoding must NOT be used
// there. Using &quot; via srcDoc would make the iframe parser see it in
// "unquoted attribute value" context, where the decoded " becomes a literal
// character instead of an attribute delimiter.
export function renderHtmlPreviewBlock(code: string): string {
  const escapedHtml = code.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return `<div class="html-preview-container"><div class="html-preview-header"><span>HTML Preview</span>${EXPAND_BTN_HTML}</div><iframe srcdoc="${escapedHtml}" sandbox="allow-scripts allow-same-origin" class="html-preview-iframe"></iframe></div>`
}

export function getHtmlPreviewLoadingHtml(): string {
  return '<div class="html-preview-loading"><span class="text-muted-foreground text-sm">Loading preview...</span></div>'
}
