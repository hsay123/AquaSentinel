/**
 * Shared, de-duplicated cache for alert evidence imagery.
 *
 * Three panels can want the same evidence for the same alert: the Before/After
 * comparison, the detail card's alert thumbnails, and (indirectly) the
 * thumbnails of the rows the user clicks. Each of them used to call
 * GET /alerts/evidence independently, and every miss is a real Earth Engine
 * render (~35s cold). Without this the same pair was rendered several times per
 * session and the panel queued three GEE jobs on load.
 *
 * Failures are deliberately NOT cached: a dropped connection should be
 * retryable, and a null that sticks forever looks exactly like "this alert has
 * no imagery", which is a different and much stronger claim.
 */

import { getAlertEvidence } from '../api/client.js'

const cache = new Map()   // key -> evidence payload (or null for a real "none")
const inflight = new Map()

export const evidenceKey = (waterbodyId, zoneId, date) =>
  `${waterbodyId}|${zoneId}|${String(date).slice(0, 10)}`

export function getEvidence(waterbodyId, zoneId, date) {
  if (!waterbodyId || !zoneId || !date) return Promise.resolve(null)
  const key = evidenceKey(waterbodyId, zoneId, date)
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  if (inflight.has(key)) return inflight.get(key)

  const p = getAlertEvidence(waterbodyId, zoneId, String(date).slice(0, 10))
    .then((d) => {
      inflight.delete(key)
      cache.set(key, d ?? null)
      return d ?? null
    })
    .catch(() => {
      inflight.delete(key)
      return null
    })

  inflight.set(key, p)
  return p
}

/** Synchronous peek, so a panel that re-renders after a sibling loaded the
 *  pair does not flash its empty state. */
export function peekEvidence(waterbodyId, zoneId, date) {
  if (!waterbodyId || !zoneId || !date) return undefined
  return cache.get(evidenceKey(waterbodyId, zoneId, date))
}
