/**
 * Proves the Time Series chart actually renders (jsdom reports 0x0 for every
 * element, so recharts' ResponsiveContainer bails out). We stub the measured
 * dimensions the way a real browser would report them, then confirm the SVG,
 * the baseline band, the observed line and the flagged marker all appear.
 */
import { JSDOM } from 'jsdom'
const dom = await JSDOM.fromURL('http://localhost:5173/_v.html', {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
})
const { window } = dom
window.HTMLCanvasElement.prototype.getContext = () => null
// Must actually fire: react-resize-detector drives ResponsiveContainer off
// ResizeObserver callbacks, so a no-op stub means the chart never renders.
window.ResizeObserver = class {
  constructor(cb) { this.cb = cb }
  observe(el) {
    this.cb([{ target: el, contentRect: { width: 620, height: 200, top: 0, left: 0 } }], this)
  }
  unobserve() {}
  disconnect() {}
}
// Pretend we have a laid-out viewport.
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 620 }, configurable: true })
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return 200 }, configurable: true })
Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get() { return 620 }, configurable: true })
Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { get() { return 200 }, configurable: true })

const t0 = Date.now()
while (Date.now() - t0 < 140000) {
  await new Promise((r) => setTimeout(r, 2000))
  if ([...window.document.querySelectorAll('img')].some((i) => i.src.includes('truecolor'))) break
}
const d = window.document
// Open the right-hand Time Series tab.
;[...d.querySelectorAll('.detail-tabs button')].find((b) => b.textContent.trim() === 'Time Series')
  ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 25000))

const scopes = {
  detailTab: d.querySelector('.detail-body .ts-chart'),
  bottomPanel: d.querySelector('.ts-panel .ts-chart'),
}
const report = {}
for (const [name, el] of Object.entries(scopes)) {
  if (!el) { report[name] = 'missing'; continue }
  const svg = el.querySelector('svg')
  const areas = [...el.querySelectorAll('.recharts-area path, path.recharts-area-curve')]
  const lines = [...el.querySelectorAll('.recharts-line path, path.recharts-line-curve')]
  const dots = el.querySelectorAll('.recharts-line-dots circle, circle')
  report[name] = {
    allPathClasses: [...el.querySelectorAll('path')].map((x) => x.getAttribute('class')),
    areaGroups: el.querySelectorAll('.recharts-area').length,
    layerClasses: [...el.querySelectorAll('.recharts-layer')].map((x) => x.getAttribute('class')).slice(0, 12),
    svgPresent: !!svg,
    svgWidth: svg?.getAttribute('width'),
    areaPaths: areas.length,
    linePaths: lines.length,
    totalPaths: el.querySelectorAll('path').length,
    circles: dots.length,
    xAxisTicks: el.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick').length,
    yAxisTicks: el.querySelectorAll('.recharts-yAxis .recharts-cartesian-axis-tick').length,
    axisLabels: [...el.querySelectorAll('.recharts-label')].map((t) => t.textContent).slice(0, 6),
  }
}
report.legend = d.querySelector('.ts-legend-inline')?.textContent?.trim() ?? null
report.dateListDemoted = !!d.querySelector('.detail-body .date-details')
console.log(JSON.stringify(report, null, 2))
