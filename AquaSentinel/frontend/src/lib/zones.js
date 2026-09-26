/**
 * Human zone labels ("Zone A3") derived from the real zone grid.
 *
 * The backend builds zones by intersecting the water mask with a 200 m UTM grid
 * (water_mask.create_zone_grid) and names them sequentially, so `zone_227` says
 * nothing about where it is. This recovers the grid position from the zone's own
 * geometry and renders it spreadsheet-style.
 *
 * It is a DISPLAY ALIAS, never a key: every provenance surface (map status line,
 * tooltips, the alert list) keeps the raw `zone_227`, so a reader can always get
 * back to the identifier the API actually uses.
 *
 * The cell centre is taken from the polygon's bounding box rather than its
 * centroid: a zone polygon is a water-mask intersection, so its centroid can be
 * pulled out of its own cell when the water is concave, which merged two
 * different zones into one label for 4 of the Yamuna cells. Bounding-box centre
 * keeps 474/478 unique; the remainder get a numeric suffix rather than a
 * silently duplicated name.
 */

const CELL_M = 200 // water_mask.create_zone_grid default
const M_PER_DEG_LAT = 111320

/** Bounding-box centre of a zone polygon, in [lon, lat]. */
function zoneCentre(zone) {
  const geom = zone.polygon
  if (!geom) return [zone.centroid_lon, zone.centroid_lat]
  const ring = geom.type === 'Polygon'
    ? geom.coordinates?.[0]
    : geom.coordinates?.[0]?.[0]
  if (!ring?.length) return [zone.centroid_lon, zone.centroid_lat]
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2]
}

/** A..Z, then AA.. so the label never runs out of rows. */
function rowLabel(index) {
  let s = ''
  let n = index
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

/**
 * Build a zone-id -> label map for one water body's zone set.
 * Returns {} for an empty set, so callers can treat "no grid" as "no labels".
 */
export function buildZoneLabels(zones) {
  if (!zones?.length) return {}
  const centres = zones.map(zoneCentre)
  const lat0 = centres.reduce((a, c) => a + c[1], 0) / centres.length
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180)

  // The grid origin is the northern/western extreme of the water body itself,
  // which is what water_mask uses (minx_u / maxy_u of the water union).
  let minLon = Infinity
  let maxLat = -Infinity
  for (const [lon, lat] of centres) {
    if (lon < minLon) minLon = lon
    if (lat > maxLat) maxLat = lat
  }

  const byCell = new Map()
  zones.forEach((z, i) => {
    const [lon, lat] = centres[i]
    const col = Math.round(((lon - minLon) * mPerDegLon) / CELL_M)
    const row = Math.round(((maxLat - lat) * M_PER_DEG_LAT) / CELL_M)
    const key = `${row}:${col}`
    if (!byCell.has(key)) byCell.set(key, [])
    byCell.get(key).push(z.id)
  })

  const labels = {}
  for (const [key, ids] of byCell) {
    const [row, col] = key.split(':').map(Number)
    const base = `${rowLabel(row)}${col + 1}`
    ids.forEach((id, n) => {
      labels[id] = n === 0 ? base : `${base}·${n + 1}`
    })
  }
  return labels
}

/** "Zone A3" for display, or the raw id when the grid is unknown. */
export function zoneName(zoneId, labels) {
  if (!zoneId) return '—'
  const alias = labels?.[zoneId]
  return alias ? `Zone ${alias}` : zoneId
}

/** Just the alias ("A3"), for tight spots like the map pin. */
export function zoneShort(zoneId, labels) {
  if (!zoneId) return '—'
  return labels?.[zoneId] ?? zoneId
}
