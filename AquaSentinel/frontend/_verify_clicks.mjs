/**
 * Bug 3 verification: three sequential zone clicks must leave the UI with
 * exactly ONE selected zone — one highlighted path, no stale tooltips, and the
 * caption / indicator tiles / chart following the same zone_id.
 */
import { JSDOM } from 'jsdom'

const dom = await JSDOM.fromURL(process.env.APP_URL || 'http://localhost:5173/_v.html', {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
})
const { window } = dom
window.HTMLCanvasElement.prototype.getContext = () => null
window.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} }

const t0 = Date.now()
while (Date.now() - t0 < 140000) {
  await new Promise((r) => setTimeout(r, 2000))
  if ([...window.document.querySelectorAll('img')].some((i) => i.src.includes('truecolor'))) break
}
const d = window.document
const zonePane = [...d.querySelectorAll('.leaflet-pane')].find((p) => p.className.includes('zones'))
const paths = [...zonePane.querySelectorAll('path')]
const txt = (s) => d.querySelector(s)?.textContent?.trim() ?? null

const selectedIds = () =>
  paths.filter((p) => (p.getAttribute('stroke') || '').toLowerCase() === '#38c8ff')
    .map((p) => d.querySelector('.map-status')?.textContent?.match(/zone_\d+ selected/)?.[0] ?? '?')

const seq = []
for (const idx of [7, 33, 91]) {
  // Re-query: selection must NOT remount the layer group, so nodes stay live.
  const live = [...zonePane.querySelectorAll('path')]
  const p = live[idx] ?? paths[idx]
  const featureId = p.getAttribute('data-zone') || `#${idx}`
  // hover first, to prove hovering opens exactly one tooltip
  p.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, view: window }))
  await new Promise((r) => setTimeout(r, 900))
  const tipsOnHover = [...d.querySelectorAll('.zone-tip')].map((t) => t.textContent.trim())
  p.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  await new Promise((r) => setTimeout(r, 3000))
  seq.push({
    clickedPath: featureId,
    tipsVisibleWhileHovered: tipsOnHover,
    tipsVisibleAfterClick: [...d.querySelectorAll('.zone-tip')].map((t) => t.textContent.trim()),
    highlightedPathCount: paths.filter((x) => (x.getAttribute('stroke') || '').toLowerCase() === '#38c8ff').length,
    caption: txt('.map-status'),
    indicatorValues: [...d.querySelectorAll('.ind-value')].map((e) => e.textContent.trim()),
    detailZonesNote: [...d.querySelectorAll('.stat-note')].map((e) => e.textContent.trim()).find((t) => /selected|zones/i.test(t || '')) ?? null,
  })
}

console.log(JSON.stringify({
  totalZonePaths: paths.length,
  selectedIdLabel: selectedIds(),
  sequence: seq,
  distinctCaptions: [...new Set(seq.map((s) => s.caption))],
  maxTooltipsAtOnce: Math.max(...seq.map((s) => s.tipsVisibleWhileHovered.length), 0),
  alwaysExactlyOneHighlight: seq.every((s) => s.highlightedPathCount === 1),
}, null, 2))
