/**
 * API client. Every function here maps 1:1 to a backend endpoint; the UI never
 * derives a number that the backend could provide.
 *
 * Missing data is signalled explicitly (null / throws with the backend's own
 * message) so components can render an "unavailable" state instead of a
 * plausible-looking placeholder.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

async function request(path, { signal, timeoutMs = 60_000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: ctrl.signal })
    if (res.status === 404) return null
    if (res.status === 204) return null
    const text = await res.text()
    let body = null
    if (text) {
      try { body = JSON.parse(text) } catch { body = { detail: text } }
    }
    if (!res.ok) {
      const detail = body?.detail
      const message =
        typeof detail === 'string'
          ? detail
          : detail?.error || detail?.message || `HTTP ${res.status}`
      const err = new Error(message)
      err.status = res.status
      err.detail = detail
      throw err
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

export const getHealth = (opts) => request('/health', opts)

/** KPI strip data: counts, real scene-date span, computed coverage, as-of date. */
export const getSummary = (opts) => request('/waterbodies/-/summary', opts)

export const getWaterbodies = (opts) => request('/waterbodies', opts)

/** Real zone grid with polygons; drives every map click target. */
export const getZones = (waterbodyId, opts) =>
  request(`/waterbodies/${encodeURIComponent(waterbodyId)}/zones`, opts)

/** Real computed stats (area, monitoring since, coverage, latest values). */
export const getWaterbodyStats = (waterbodyId, opts) =>
  request(`/waterbodies/${encodeURIComponent(waterbodyId)}/stats`, opts)

/** Real time series with baseline band + flagged point for one zone/index. */
export const getTimeseries = (waterbodyId, zoneId, index, opts) =>
  request(
    `/waterbodies/${encodeURIComponent(waterbodyId)}/timeseries` +
    `?zone_id=${encodeURIComponent(zoneId)}&index=${encodeURIComponent(index)}`,
    opts,
  )

/** Real alerts for a water body, computed on demand from the cache. */
export const getAlerts = (waterbodyId, opts) =>
  request(`/alerts?waterbody_id=${encodeURIComponent(waterbodyId)}`, {
    timeoutMs: 180_000,
    ...opts,
  })

/** Real rendered index heatmap PNG (decorated figure; used for evidence). */
export const getIndexMap = (waterbodyId, index, date, opts) =>
  request(
    `/renders/index-map?waterbody_id=${encodeURIComponent(waterbodyId)}` +
    `&index=${encodeURIComponent(index)}&date=${encodeURIComponent(date)}`,
    { timeoutMs: 180_000, ...opts },
  )

/**
 * Clean, georeferenced RGBA index overlay for the Leaflet ImageOverlay.
 * Unlike /index-map this is exactly the data grid (no axes/colourbar/title) and
 * off-water pixels are alpha 0, so it lines up with the reported bounds and lets
 * the satellite imagery show through on land.
 */
export const getIndexOverlay = (waterbodyId, index, date, opts) =>
  request(
    `/renders/overlay?waterbody_id=${encodeURIComponent(waterbodyId)}` +
    `&index=${encodeURIComponent(index)}&date=${encodeURIComponent(date)}`,
    { timeoutMs: 180_000, ...opts },
  )

/** Clean, georeferenced true-colour raster for the map base layer. */
export const getTrueColorRaster = (waterbodyId, date, opts) =>
  request(
    `/renders/true-color-raster?waterbody_id=${encodeURIComponent(waterbodyId)}` +
    `&date=${encodeURIComponent(date)}`,
    { timeoutMs: 180_000, ...opts },
  )

/** Real rendered true-colour composite (decorated figure; evidence use). */
export const getTrueColor = (waterbodyId, date, opts) =>
  request(
    `/renders/true-color?waterbody_id=${encodeURIComponent(waterbodyId)}` +
    `&date=${encodeURIComponent(date)}`,
    { timeoutMs: 180_000, ...opts },
  )

export const getLegend = (index, opts) =>
  request(`/renders/legend?index=${encodeURIComponent(index)}`, opts)

export { API_BASE }
