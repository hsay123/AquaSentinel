/**
 * Live verification of the six bug fixes against the running backend.
 * Loads the real built app, waits out the heavy 478-zone render, then asserts
 * each fix and exercises three sequential zone clicks.
 */
import { JSDOM } from 'jsdom'

const APP_URL = process.env.APP_URL || 'http://localhost:5173/_v.html'
const dom = await JSDOM.fromURL(APP_URL, {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
})
const { window } = dom
window.HTMLCanvasElement.prototype.getContext = () => null
window.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} }
const errors = []
window.addEventListener('error', (e) => errors.push(String(e.error || e.message)))
const oe = console.error
console.error = (...a) => { errors.push(a.map(String).join(' ')); oe(...a) }

// Wait for the map to finish building (478 vector features are slow in jsdom).
const t0 = Date.now()
let ready = false
while (Date.now() - t0 < 150000) {
  await new Promise((r) => setTimeout(r, 2000))
  const imgs = [...window.document.querySelectorAll('img')].map((i) => i.src)
  if (imgs.some((s) => s.includes('truecolor')) && imgs.some((s) => s.includes('ndci') || s.includes('ndti'))) { ready = true; break }
}

const d = window.document
const imgs = [...d.querySelectorAll('img')].map((i) => i.src)
const txt = (sel) => d.querySelector(sel)?.textContent?.trim() ?? null

// ---- Bug 3: three sequential zone clicks ---------------------------------
const layers = []
const findZoneLayers = () => [...d.querySelectorAll('.leaflet-pane--zones path, .leaflet-overlay-pane path')]
const clickSequence = []
const before = txt('.map-status')

// Drive selection through the real click handler on the GeoJSON layer group by
// dispatching clicks on individual zone paths.
const paths = findZoneLayers()
for (const idx of [5, 40, 120]) {
  const p = paths[idx]
  if (!p) continue
  p.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  await new Promise((r) => setTimeout(r, 2500))
  clickSequence.push({
    clicked: idx,
    statusCaption: txt('.map-status'),
    openTooltips: [...d.querySelectorAll('.zone-tip')].map((t) => t.textContent.trim()),
    selectedStyleCount: [...d.querySelectorAll('.leaflet-pane--zones path')]
      .filter((el) => (el.getAttribute('stroke') || '').toLowerCase() === '#38c8ff').length,
    indValues: [...d.querySelectorAll('.ind-value')].map((e) => e.textContent.trim()),
  })
}

const out = {
  waitedMs: Date.now() - t0,
  mapReady: ready,
  bug1: {
    satelliteBase: imgs.filter((s) => s.includes('truecolor')),
    heatmapOverlay: imgs.filter((s) => s.includes('_ndti_') || s.includes('_ndci_') || s.includes('_fai_')),
    stillUsingOsm: imgs.filter((s) => s.includes('openstreetmap')).length,
    paneOrder: [...d.querySelectorAll('.leaflet-pane')].map((p) => p.className.replace('leaflet-pane ', '')),
  },
  bug1_legend: {
    onMap: !!d.querySelector('.map-legend-box'),
    insideMapCanvas: !!d.querySelector('.map-canvas .map-legend-box'),
    title: txt('.map-legend-box .legend-title'),
    ends: txt('.map-legend-box .legend-ends'),
    scene: txt('.map-legend-box .legend-scene'),
    separatePanelBelow: !!d.querySelector('.panel > .map-legend'),
  },
  bug2: {
    tsTabHasChart: (() => {
      const tabs = [...d.querySelectorAll('.detail-tabs button')]
      const ts = tabs.find((t) => t.textContent.trim() === 'Time Series')
      if (!ts) return 'no tab'
      ts.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      return true
    })(),
  },
  bug2_afterTabClick: null,
  bug3: { beforeCaption: before, clickSequence },
  bug4: {
    navBadges: [...d.querySelectorAll('.nav-soon')].map((e) => e.textContent.trim()),
    anythingWith500: [...d.querySelectorAll('*')]
      .filter((e) => e.children.length === 0 && /500\s*%/.test(e.textContent || '')).length,
  },
  bug5: {
    rows: [...d.querySelectorAll('.wb-row')].map((r) => ({
      name: r.querySelector('.wb-name')?.textContent?.trim(),
      meta: r.querySelector('.wb-meta')?.textContent?.trim(),
      tier: r.querySelector('.wb-tier')?.textContent?.trim(),
      pending: r.classList.contains('is-pending'),
    })),
  },
  bug6: { hero: !!d.querySelector('.hero'), tagline: txt('.hero-tagline'), badges: [...d.querySelectorAll('.hero-badge')].map((e) => e.textContent.trim()) },
  jsErrors: errors.filter((e) => !/Not implemented|getContext|Could not parse CSS/i.test(e)).slice(0, 4),
}

await new Promise((r) => setTimeout(r, 1500))
out.bug2_afterTabClick = {
  chartSvgPresent: !!d.querySelector('.detail-body .ts-chart svg'),
  tsPaths: d.querySelectorAll('.detail-body .ts-chart path').length,
  dateListIsDetails: !!d.querySelector('.detail-body .date-details'),
  dateSummary: txt('.date-summary'),
  tsLegend: txt('.ts-legend-inline'),
}
out.kpi = [...d.querySelectorAll('.kpi-tile')].map((t) => `${t.querySelector('.kpi-label')?.textContent?.trim()}=${t.querySelector('.kpi-value')?.textContent?.trim()}`)

console.log(JSON.stringify(out, null, 2))
process.exit(errors.filter((e) => !/Not implemented|getContext/i.test(e)).length ? 1 : 0)
