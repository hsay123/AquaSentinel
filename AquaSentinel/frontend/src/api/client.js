/**
 * API client. Every function here maps 1:1 to a backend endpoint; the UI never
 * derives a number that the backend could provide.
 *
 * Missing data is signalled explicitly (null / throws with the backend's own
 * message) so components can render an "unavailable" state instead of a
 * plausible-looking placeholder.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

/**
 * Per-endpoint deadlines. Every request terminates: success, error, no-data or
 * TIMEOUT. A timeout is a distinct outcome rather than being folded into
 * "error", because the two call for different responses (retry vs. fix the
 * backend) and only one of them is actionable by the user.
 *
 * Renders get the longest budget because a genuine cold Earth Engine render
 * really does take 10-35 s. Everything the map needs on a warm cache now
 * answers in milliseconds, since the render endpoints consult the composite
 * cache BEFORE calling resolve_scene().
 */
const DEFAULT_TIMEOUT_MS = 30_000
const RENDER_TIMEOUT_MS = 45_000

function timeoutError(ms) {
  const err = new Error(`Request timed out after ${Math.round(ms / 1000)}s`)
  err.timedOut = true
  return err
}

async function request(path, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
  } catch (e) {
    // An abort is a timeout only when OUR deadline fired: a caller-supplied
    // abort is a deliberate cancellation and must not masquerade as one.
    if (e?.name === 'AbortError' && !signal?.aborted) throw timeoutError(timeoutMs)
    throw e
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

/**
 * Real before/after evidence pair for one flagged zone/date.
 *
 * The alert feed deliberately does not render Earth Engine imagery inline (that
 * stalled the feed), so the two thumbnails are fetched here, on demand, only
 * for the alert the user actually has selected. Results are cached on disk by
 * the backend, so a repeat selection is instant.
 */
export const getAlertEvidence = (waterbodyId, zoneId, date, opts) =>
  request(
    `/alerts/evidence?waterbody_id=${encodeURIComponent(waterbodyId)}` +
    `&zone_id=${encodeURIComponent(zoneId)}&date=${encodeURIComponent(date)}`,
    { timeoutMs: 240_000, ...opts },
  )

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
    { timeoutMs: RENDER_TIMEOUT_MS, ...opts },
  )

/** Clean, georeferenced true-colour raster for the map base layer. */
export const getTrueColorRaster = (waterbodyId, date, opts) =>
  request(
    `/renders/true-color-raster?waterbody_id=${encodeURIComponent(waterbodyId)}` +
    `&date=${encodeURIComponent(date)}`,
    { timeoutMs: RENDER_TIMEOUT_MS, ...opts },
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
