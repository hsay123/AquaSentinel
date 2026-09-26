/**
 * Index colour ramps — one definition, two consumers.
 *
 * These are the same stops backend/pipeline/render.py uses for the per-pixel
 * index rasters, so the legend under the map and the swatch on an indicator
 * card always describe the identical scale. They lived inside MapPanel.jsx,
 * which made the map the only place that could talk about the ramp at all;
 * extracting them here is what lets the indicator panel reuse the colourbar
 * pattern instead of inventing a second one.
 */

/** Ordered low -> high stops, mirroring render.py's colormaps. */
export const COLORMAPS = {
  ndti: ['#08306b', '#3182bd', '#bdd7e7', '#fdd0a2', '#fd8d3c', '#a63603'],
  ndci: ['#08306b', '#2171b5', '#41b6c4', '#d9f0d3', '#fec44f', '#7f0000'],
  fai: ['#1a1a1a', '#4a1486', '#c2185b', '#ff7043', '#ffd54f', '#f0f4c3'],
}

/** texture_score has no rendered raster (the pipeline writes None), so it gets
 *  no ramp rather than a borrowed one. */
export function colorStops(index) {
  const p = COLORMAPS[index] ?? null
  if (!p) return null
  return p.map((c, i) => `${c} ${(i / (p.length - 1)) * 100}%`).join(', ')
}

/** A mid-ramp colour, used for a card's value swatch / marker. */
export function colorAt(index, t) {
  const p = COLORMAPS[index]
  if (!p) return null
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0))
  const pos = clamped * (p.length - 1)
  const i = Math.min(p.length - 2, Math.floor(pos))
  return mix(p[i], p[i + 1], pos - i)
}

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

function mix(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  const c = (x, y) => Math.round(x + (y - x) * t)
  return `rgb(${c(r1, r2)}, ${c(g1, g2)}, ${c(b1, b2)})`
}
