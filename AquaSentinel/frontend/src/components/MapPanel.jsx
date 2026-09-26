/**
 * Map panel: the primary interaction.
 *
 * Layers, all real:
 *   - basemap: OpenStreetMap tiles (no key, no watermark failure mode)
 *   - zone polygons: GET /waterbodies/{id}/zones (real cached grid geometry)
 *   - index heatmap: server-rendered PNG of the real per-pixel index for the
 *     selected date, placed at the real bounds the renderer reported
 *   - date navigator: steps ONLY through real scene dates from /stats
 *
 * Clicking a zone calls onSelectZone(zone_id) and that drives every other panel.
 */

import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, GeoJSON, ImageOverlay, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { CaretLeft, CaretRight, MapPin } from '@phosphor-icons/react'
import { getIndexMap } from '../api/client.js'
import { INDEX_META, fmtDate, fmtNum, severityOf } from '../lib/format.js'
import { Skeleton, Unavailable, ErrorNote } from './States.jsx'

const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

/** Fly to the AOI whenever the water body changes. */
function FlyTo({ bounds }) {
  const map = useMap()
  useEffect(() => {
    if (bounds && bounds.length === 4) {
      const [w, s, e, n] = bounds
      map.fitBounds([[s, w], [n, e]], { padding: [40, 40] })
    }
  }, [map, bounds])
  return null
}

function aoiBounds(geojson) {
  if (!geojson) return null
  const coords = geojson.type === 'Polygon'
    ? geojson.coordinates[0]
    : geojson.coordinates?.[0]?.[0]
  if (!coords) return null
  const lons = coords.map((c) => c[0])
  const lats = coords.map((c) => c[1])
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
}

export function MapPanel({
  waterbody, zones, selectedZoneId, onSelectZone, stats, loadingZones, zonesError,
}) {
  const [index, setIndex] = useState('ndti')
  const sceneDates = stats?.scene_dates ?? []
  const [dateIdx, setDateIdx] = useState(sceneDates.length - 1)

  // Keep the date index valid when the water body (and its scene list) changes.
  useEffect(() => {
    setDateIdx(sceneDates.length - 1)
  }, [waterbody?.id, sceneDates.length])

  const date = sceneDates[dateIdx] ?? null

  const [overlay, setOverlay] = useState({ state: 'idle', data: null, error: null })
  useEffect(() => {
    if (!waterbody || !date) { setOverlay({ state: 'idle', data: null, error: null }); return }
    let cancelled = false
    setOverlay({ state: 'loading', data: null, error: null })
    getIndexMap(waterbody.id, index, date)
      .then((d) => { if (!cancelled) setOverlay(d ? { state: 'ready', data: d, error: null } : { state: 'unavailable', data: null, error: null }) })
      .catch((e) => { if (!cancelled) setOverlay({ state: 'unavailable', data: null, error: e }) })
    return () => { cancelled = true }
  }, [waterbody?.id, index, date])

  const geojson = useMemo(() => {
    if (!zones?.length) return null
    return {
      type: 'FeatureCollection',
      features: zones.map((z) => ({
        type: 'Feature',
        id: z.id,
        geometry: z.polygon,
        properties: { id: z.id, area_m2: z.area_m2 },
      })),
    }
  }, [zones])

  const onEachFeature = (feature, layer) => {
    const id = feature.properties.id
    layer.bindTooltip(id, { sticky: true, className: 'zone-tip' })
    layer.on({
      click: () => onSelectZone(id),
      mouseover: (e) => e.target.setStyle({ weight: 2, color: '#38C8FF' }),
      mouseout: (e) => e.target.setStyle({ weight: selectedZoneId === id ? 2.5 : 1, color: selectedZoneId === id ? '#38C8FF' : '#5BE0C0' }),
    })
  }

  const styleFor = (feature) => {
    const id = feature.properties.id
    const selected = id === selectedZoneId
    return {
      // Zones are the monitored area; the reference's severity colour is
      // reserved for zones that actually carry an alert, so un-flagged zones
      // stay neutral rather than being painted a status colour they haven't earned.
      color: selected ? '#38C8FF' : '#5BE0C0',
      weight: selected ? 2.5 : 0.6,
      opacity: selected ? 1 : 0.55,
      fillColor: '#38C8FF',
      fillOpacity: selected ? 0.18 : 0.04,
    }
  }

  const bounds = aoiBounds(waterbody?.aoi_geojson)

  return (
    <section className="panel map-panel">
      <div className="panel-head">
        <div className="panel-title">
          <MapPin size={14} weight="duotone" />
          <span>{waterbody ? waterbody.name : 'Select a water body'}</span>
        </div>
        <div className="map-controls">
          <div className="seg">
            {['ndti', 'ndci', 'fai'].map((k) => (
              <button
                key={k}
                type="button"
                className={index === k ? 'is-active' : ''}
                onClick={() => setIndex(k)}
                title={INDEX_META[k].label}
              >
                {INDEX_META[k].short}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="map-canvas">
        {waterbody ? (
          <MapContainer
            center={[28.56, 77.31]}
            zoom={11}
            scrollWheelZoom
            className="map"
            zoomControl={false}
            attributionControl={false}
          >
            <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} maxZoom={19} />
            <FlyTo bounds={bounds} />

            {/* Real server-rendered index raster, placed at its real bounds.
                The API returns [S, W, N, E]; Leaflet's ImageOverlay needs two
                corners [[s, w], [n, e]]. Passing the flat array throws inside
                LatLngBounds. */}
            {overlay.state === 'ready' && overlay.data?.bounds?.length === 4 && (
              <ImageOverlay
                url={overlay.data.image_url}
                bounds={[
                  [overlay.data.bounds[0], overlay.data.bounds[1]],
                  [overlay.data.bounds[2], overlay.data.bounds[3]],
                ]}
                opacity={0.85}
              />
            )}

            {geojson && (
              <GeoJSON
                key={`${waterbody.id}-${selectedZoneId}`}
                data={geojson}
                style={styleFor}
                onEachFeature={onEachFeature}
              />
            )}
          </MapContainer>
        ) : (
          <div className="map-placeholder">No water body selected.</div>
        )}

        {/* Date navigator: only real scene dates are offered. */}
        <div className="date-nav">
          <button
            type="button"
            disabled={dateIdx <= 0}
            onClick={() => setDateIdx((i) => Math.max(0, i - 1))}
            aria-label="Previous scene"
          >
            <CaretLeft size={14} weight="bold" />
          </button>
          <span className="date-nav-label mono">
            {date ? fmtDate(date) : '—'}
          </span>
          <button
            type="button"
            disabled={dateIdx >= sceneDates.length - 1}
            onClick={() => setDateIdx((i) => Math.min(sceneDates.length - 1, i + 1))}
            aria-label="Next scene"
          >
            <CaretRight size={14} weight="bold" />
          </button>
        </div>
      </div>

      {/* Legend carries the real index name and the real min/max of the data drawn. */}
      <div className="map-legend">
        {overlay.state === 'loading' && <Skeleton lines={1} height={14} />}
        {overlay.state === 'ready' && overlay.data && (
          <>
            <div className="legend-head">
              <span className="legend-title">{overlay.data.title ?? INDEX_META[index].label}</span>
              <span className="legend-range mono">
                {fmtNum(overlay.data.vmin, 3)} – {fmtNum(overlay.data.vmax, 3)}
              </span>
            </div>
            <div className="legend-bar" style={{ background: `linear-gradient(to right, ${legendStops(index)})` }} />
            <div className="legend-note">
              Per-pixel {INDEX_META[index].short} from the real scene
              {' '}<span className="mono">{String(overlay.data.scene_id).split('/').pop()}</span>
              {overlay.data.scale_m ? ` · sampled at ${overlay.data.scale_m} m` : ''}
            </div>
            {overlay.data.description && (
              <div className="legend-desc">{overlay.data.description}</div>
            )}
          </>
        )}
        {overlay.state === 'unavailable' && (
          <Unavailable
            compact
            title={`No ${INDEX_META[index].short} raster for this date`}
            reason={
              overlay.error?.message ??
              'The scene has no usable water pixels after cloud and water masking.'
            }
            source="backend/pipeline/render.py"
          />
        )}
      </div>

      {loadingZones && (
        <div className="map-status"><Skeleton lines={1} height={12} /></div>
      )}
      {zonesError && (
        <div className="map-status"><ErrorNote error={zonesError} /></div>
      )}
      {!loadingZones && !zonesError && zones?.length > 0 && (
        <div className="map-status mono">
          {zones.length} real zones cached · {selectedZoneId ? `${selectedZoneId} selected` : 'click a zone'}
        </div>
      )}
    </section>
  )
}

/** CSS gradient stops mirroring render.py's colormaps. */
function legendStops(index) {
  const palettes = {
    ndti: ['#08306b', '#3182bd', '#bdd7e7', '#fdd0a2', '#fd8d3c', '#a63603'],
    ndci: ['#08306b', '#2171b5', '#41b6c4', '#d9f0d3', '#fec44f', '#7f0000'],
    fai: ['#1a1a1a', '#4a1486', '#c2185b', '#ff7043', '#ffd54f', '#f0f4c3'],
  }
  const p = palettes[index] ?? palettes.ndti
  return p.map((c) => `${c} ${(p.indexOf(c) / (p.length - 1)) * 100}%`).join(', ')
}
