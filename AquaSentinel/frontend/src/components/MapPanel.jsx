/**
 * Map panel: satellite base + index heatmap + on-map legend.
 *
 * Layers, bottom to top, all real:
 *   1. base  : the real Sentinel-2 true-colour composite for the selected
 *              water body and date (rendered by backend/pipeline/render.py).
 *              OpenStreetMap tiles sit underneath purely as a fallback for
 *              dates where no composite can be produced.
 *   2. heatmap: the real per-pixel index raster for the same scene, at the
 *              real bounds the renderer reported.
 *   3. zones : the real persisted zone grid, clickable.
 *
 * Explicit z-index panes guarantee the heatmap sits above the imagery and the
 * zone vectors above the heatmap, regardless of Leaflet's default ordering.
 *
 * Zone selection: exactly one zone can be selected (props.selectedZoneId is the
 * single source of truth in App state). Hover opens a tooltip on that one layer
 * and closes any previously open one, so two zone labels can never be visible
 * at once. Hover is styled as a thin outline; selection is a solid fill — the
 * two are visually distinct.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, GeoJSON, ImageOverlay, Pane, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import { getIndexMap, getTrueColor } from '../api/client.js'
import { INDEX_META, fmtDate, fmtNum } from '../lib/format.js'
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
      map.fitBounds([[s, w], [n, e]], { padding: [30, 30] })
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

/** The API returns [S, W, N, E]; Leaflet ImageOverlay needs [[s,w],[n,e]]. */
function toCorners(flat) {
  if (!flat || flat.length !== 4) return null
  return [[flat[0], flat[1]], [flat[2], flat[3]]]
}

export function MapPanel({
  waterbody, zones, selectedZoneId, onSelectZone, stats, loadingZones, zonesError,
}) {
  const [index, setIndex] = useState('ndti')
  const sceneDates = stats?.scene_dates ?? []
  const [dateIdx, setDateIdx] = useState(sceneDates.length - 1)
  const [showHeatmap, setShowHeatmap] = useState(true)

  useEffect(() => {
    setDateIdx(sceneDates.length - 1)
  }, [waterbody?.id, sceneDates.length])

  const date = sceneDates[dateIdx] ?? null

  const [base, setBase] = useState({ state: 'idle', data: null, error: null })
  const [heat, setHeat] = useState({ state: 'idle', data: null, error: null })

  // Real true-colour composite = the satellite base layer for this scene.
  useEffect(() => {
    if (!waterbody || !date) { setBase({ state: 'idle', data: null, error: null }); return }
    let dead = false
    setBase({ state: 'loading', data: null, error: null })
    getTrueColor(waterbody.id, date)
      .then((d) => { if (!dead) setBase(d ? { state: 'ready', data: d, error: null } : { state: 'unavailable', data: null, error: null }) })
      .catch((e) => { if (!dead) setBase({ state: 'unavailable', data: null, error: e }) })
    return () => { dead = true }
  }, [waterbody?.id, date])

  // Real per-pixel index heatmap for the same scene.
  useEffect(() => {
    if (!waterbody || !date) { setHeat({ state: 'idle', data: null, error: null }); return }
    let dead = false
    setHeat({ state: 'loading', data: null, error: null })
    getIndexMap(waterbody.id, index, date)
      .then((d) => { if (!dead) setHeat(d ? { state: 'ready', data: d, error: null } : { state: 'unavailable', data: null, error: null }) })
      .catch((e) => { if (!dead) setHeat({ state: 'unavailable', data: null, error: e }) })
    return () => { dead = true }
  }, [waterbody?.id, index, date])

  const geojson = useMemo(() => {
    if (!zones?.length) return null
    return {
      type: 'FeatureCollection',
      features: zones.map((z) => ({
        type: 'Feature',
        id: z.id,
        geometry: z.polygon,
        properties: { id: z.id },
      })),
    }
  }, [zones])

  // Track the one open tooltip so a second hover closes the first. Without this
  // Leaflet leaves stale labels on screen and two zone IDs appear at once.
  const openTipRef = useRef(null)
  // zone_id -> leaflet layer. Used to restyle on selection without remounting
  // the layer group.
  const layerByIdRef = useRef(new Map())

  const onEachFeature = (feature, layer) => {
    const id = feature.properties.id
    layerByIdRef.current.set(id, layer)

    layer.on({
      mouseover: (e) => {
        if (openTipRef.current && openTipRef.current !== e.target) {
          openTipRef.current.closeTooltip()
        }
        // Hover reads as a thin outline only; selection is the solid fill.
        e.target.setStyle({ weight: 2, color: '#38C8FF', fillOpacity: 0.12 })
        e.target.bringToFront?.()
        e.target.bindTooltip(id, { className: 'zone-tip', sticky: false, direction: 'top' })
        e.target.openTooltip()
        openTipRef.current = e.target
      },
      mouseout: (e) => {
        e.target.setStyle(styleForId(e.target.feature.properties.id))
        e.target.closeTooltip()
        if (openTipRef.current === e.target) openTipRef.current = null
      },
      click: (e) => {
        L.DomEvent.stopPropagation(e)
        // Selection is shown by the persistent highlight, so the hover tooltip
        // is dismissed on click rather than left floating over the new zone.
        e.target.closeTooltip()
        if (openTipRef.current === e.target) openTipRef.current = null
        onSelectZone(id)
      },
    })
  }

  // Single source of truth for the selected zone. Selection restyles exactly
  // two layers (the previously selected and the new one) rather than remounting
  // all 478 — remounting on every click destroyed the DOM the user had just
  // clicked and made selection feel broken.
  const styleForId = (id) => {
    const selected = id === selectedZoneId
    return {
      color: selected ? '#38C8FF' : 'rgba(91, 224, 192, 0.55)',
      weight: selected ? 2.5 : 0.5,
      opacity: selected ? 1 : 0.7,
      fillColor: '#38C8FF',
      fillOpacity: selected ? 0.22 : 0.03,
    }
  }

  const prevSelectedRef = useRef(selectedZoneId)
  useEffect(() => {
    const prev = prevSelectedRef.current
    if (prev === selectedZoneId) return
    const byId = layerByIdRef.current
    if (prev && byId.has(prev)) byId.get(prev).setStyle(styleForId(prev))
    if (selectedZoneId && byId.has(selectedZoneId)) {
      const layer = byId.get(selectedZoneId)
      layer.setStyle(styleForId(selectedZoneId))
      layer.bringToFront?.()
    }
    prevSelectedRef.current = selectedZoneId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedZoneId, zones])

  const styleFor = (feature) => styleForId(feature.properties.id)

  const bounds = aoiBounds(waterbody?.aoi_geojson)
  const baseCorners = toCorners(base.data?.bounds)
  const heatCorners = toCorners(heat.data?.bounds)
  const heatReady = showHeatmap && heat.state === 'ready' && heatCorners

  const legendData = heat.state === 'ready' ? heat.data : null

  return (
    <section className="panel map-panel">
      <div className="panel-head">
        <div className="panel-title">
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
          <label className="map-toggle" title="Show or hide the index overlay">
            <input
              type="checkbox"
              checked={showHeatmap}
              onChange={(e) => setShowHeatmap(e.target.checked)}
            />
            Overlay
          </label>
        </div>
      </div>

      <div className="map-canvas">
        {waterbody ? (
          <MapContainer
            center={[28.56, 77.31]}
            zoom={12}
            scrollWheelZoom
            className="map"
            zoomControl={false}
            attributionControl={false}
          >
            {/* Fallback context, beneath the real imagery. */}
            <Pane name="osm" style={{ zIndex: 190 }}>
              <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} maxZoom={19} />
            </Pane>

            {/* Real Sentinel-2 true-colour composite = the base layer. */}
            <Pane name="satellite" style={{ zIndex: 210 }}>
              {base.state === 'ready' && baseCorners && (
                <ImageOverlay url={base.data.image_url} bounds={baseCorners} opacity={1} />
              )}
            </Pane>

            {/* Real per-pixel index raster, above the imagery. */}
            <Pane name="heatmap" style={{ zIndex: 320 }}>
              {heatReady && (
                <ImageOverlay url={heat.data.image_url} bounds={heatCorners} opacity={0.75} />
              )}
            </Pane>

            {/* Zone vectors stay on top so they remain clickable. */}
            <Pane name="zones" style={{ zIndex: 430 }}>
              {geojson && (
                <GeoJSON
                  key={waterbody.id}
                  data={geojson}
                  style={styleFor}
                  onEachFeature={onEachFeature}
                />
              )}
            </Pane>

            <FlyTo bounds={bounds} />
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
          <span className="date-nav-label mono">{date ? fmtDate(date) : '—'}</span>
          <button
            type="button"
            disabled={dateIdx >= sceneDates.length - 1}
            onClick={() => setDateIdx((i) => Math.min(sceneDates.length - 1, i + 1))}
            aria-label="Next scene"
          >
            <CaretRight size={14} weight="bold" />
          </button>
        </div>

        {/* Legend lives ON the map, in a corner — not in a panel underneath. */}
        <div className="map-legend-box">
          <div className="legend-title">
            {legendData ? (legendData.title ?? INDEX_META[index].label) : INDEX_META[index].label}
          </div>

          {heat.state === 'loading' && <Skeleton lines={1} height={10} />}

          {legendData && (
            <>
              <div
                className="legend-bar"
                style={{ background: `linear-gradient(to right, ${legendStops(index)})` }}
              />
              <div className="legend-ends">
                <span className="mono">Low {fmtNum(legendData.vmin, 2)}</span>
                <span className="mono">{fmtNum(legendData.vmax, 2)} High</span>
              </div>
              <div className="legend-scene mono">
                {String(legendData.scene_id).split('/').pop()?.slice(0, 22)}
              </div>
            </>
          )}

          {heat.state === 'unavailable' && (
            <Unavailable
              compact
              title={`No ${INDEX_META[index].short} for this date`}
              reason={heat.error?.message ?? 'No usable water pixels after cloud and water masking.'}
            />
          )}

          <div className="legend-foot">
            {base.state === 'ready'
              ? 'Base: real Sentinel-2 true colour'
              : base.state === 'loading'
                ? 'Base: loading composite…'
                : 'Base: street tiles (composite unavailable)'}
          </div>
        </div>
      </div>

      <div className="map-status mono">
        {loadingZones
          ? 'loading zone grid…'
          : zonesError
            ? null
            : zones?.length
              ? `${zones.length} real zones cached · ${selectedZoneId ?? 'none'} selected`
              : 'no zone geometry cached'}
        {zonesError ? <ErrorNote error={zonesError} /> : null}
      </div>
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
  return p.map((c, i) => `${c} ${(i / (p.length - 1)) * 100}%`).join(', ')
}
