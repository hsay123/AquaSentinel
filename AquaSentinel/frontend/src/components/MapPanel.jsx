/**
 * Map body — a bounded card that fills its grid cell, with the index heatmap
 * rendered by the backend as a per-pixel colour raster (see below).
 *
 * THE HEATMAP IS REAL, NOT A CSS EFFECT. GET /renders/overlay returns an RGBA
 * PNG of the index for that exact scene at the exact AOI bounds, with off-water
 * pixels at alpha 0 — the per-scene Otsu MNDWI water mask, computed in GEE. It
 * is placed as a Leaflet ImageOverlay in its own pane above the true-colour
 * composite, so the gradient is clipped to the water body by the mask itself
 * rather than by a polygon approximation. Nothing is computed client-side.
 *
 * Map CHROME (search, month navigator, icon rail, legend, scale bar) floats
 * inside the map card — it belongs to the map, and the mockup's cards are
 * chrome rather than dashboard panels. The six dashboard regions remain grid
 * cells; nothing is positioned over the map from outside the card.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, GeoJSON, ImageOverlay, Marker, Pane, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import {
  ArrowsOut, ArrowsIn, CaretLeft, CaretRight, ChartLine, Crosshair, Stack, MagnifyingGlass,
} from '@phosphor-icons/react'
import { getIndexOverlay } from '../api/client.js'
import { INDEX_META, fmtDate, fmtNum, fmtMonth } from '../lib/format.js'
import { colorStops } from '../lib/colormaps.js'
import { zoneShort } from '../lib/zones.js'
import { Skeleton, ErrorNote } from './States.jsx'

const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

/** Module-level so the fit effect does not re-run on every render. */
const FIT_PADDING = [28, 28]

/**
 * Frame the water body's AOI — the GeoVisionAI `BoundsFitter` pattern.
 *
 * The composite is a BOUNDED image overlay, not a basemap: a pre-rendered PNG
 * for one Sentinel-2 acquisition, positioned at the exact bounds recovered from
 * the GEE sampling grid and clipped to those bounds. Context outside the AOI is
 * the vector basemap, which is legitimate and is what the reference
 * implementation does (its MapView keeps a TileLayer mounted at all times and
 * lays the analysis ImageOverlay on top of it).
 *
 * Bounds are never hand-typed here. They arrive from the raster's own metadata
 * (`bounds` in the cached render's meta.json), which the pipeline computes from
 * the pixel coordinates GEE actually returned. Measured against the AOI
 * polygons: worst edge delta 46-113 m on a ~5 km AOI, which is the expected
 * snap of a 20 m sampling grid to whole pixels, and the base and index rasters
 * for a given date share bit-identical bounds and grid, so they are exactly
 * co-registered.
 *
 * `invalidateSize` is called on every fit AND from a ResizeObserver: the map
 * card is a grid cell, so Leaflet initially measures it before layout settles
 * and the first fit would otherwise be computed against a stale container size.
 */
function FitToRaster({ bounds }) {
  const map = useMap()
  const fitRef = useRef(null)

  const fit = useCallback(() => {
    if (!bounds || bounds.length !== 4) return
    const [w, s, e, n] = bounds
    map.fitBounds([[s, w], [n, e]], { padding: FIT_PADDING, animate: false })
    map.invalidateSize()
  }, [map, bounds])

  fitRef.current = fit

  useEffect(() => { fit() }, [fit])

  // The card is a grid cell: it changes size on window resize, on entering
  // fullscreen, and when the responsive breakpoints rearrange the grid. The
  // first callback re-fits as well, because layout settles after mount.
  useEffect(() => {
    const el = map.getContainer()
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) { first = false; fitRef.current(); return }
      map.invalidateSize({ animate: false })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [map])

  return null
}

/** Fit the map to the AOI. Driven by the icon rail's locate button. */
function FitRequest({ bounds, request }) {
  const map = useMap()
  useEffect(() => {
    if (!bounds || bounds.length !== 4 || !request) return
    const [w, s, e, n] = bounds
    map.invalidateSize()
    map.fitBounds([[s, w], [n, e]], { padding: [30, 30] })
  }, [map, bounds, request])
  return null
}

/**
 * Scale bar. Real, not decorative: it measures the map's own ground resolution
 * by asking Leaflet for the real distance between two pixels, then snaps to a
 * round distance so the label stays readable while the map moves.
 */
function ScaleBar() {
  const map = useMap()
  const [text, setText] = useState(null)

  useEffect(() => {
    const NICE = [10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]
    const update = () => {
      const size = map.getSize()
      const y = size.y / 2
      const a = map.containerPointToLatLng([size.x / 2, y])
      const b = map.containerPointToLatLng([size.x / 2 + 100, y])
      const metresPer100px = a.distanceTo(b)
      if (!Number.isFinite(metresPer100px) || metresPer100px <= 0) return
      const target = NICE.find((n) => n >= metresPer100px * 0.5) ?? NICE[NICE.length - 1]
      const px = (target / metresPer100px) * 100
      setText({ label: target >= 1000 ? `${target / 1000} km` : `${target} m`, px })
    }
    update()
    map.on('move zoom resize', update)
    return () => { map.off('move zoom resize', update) }
  }, [map])

  if (!text) return null
  return (
    <div className="map-scale" aria-label="Map scale">
      <div className="map-scale-bar" style={{ width: `${Math.round(text.px)}px` }} />
      <span className="mono">{text.label}</span>
    </div>
  )
}

/** A white dot + zone label at the active zone's centroid, as a real marker. */
function ZonePin({ zone, label }) {
  const icon = useMemo(() => L.divIcon({
    className: 'zone-pin-icon',
    html: `<span class="zone-pin-dot"></span><span class="zone-pin-label">${label}</span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  }), [label])

  if (!zone) return null
  return (
    <Marker
      position={[zone.centroid_lat, zone.centroid_lon]}
      icon={icon}
      interactive={false}
      keyboard={false}
      zIndexOffset={500}
    />
  )
}

export function MapPanel({
  waterbody, waterbodies = [], onSelectWaterbody, zones, selectedZoneId, onSelectZone,
  sceneDates, sceneDate, onSceneChange, base, loadingZones, zonesError, zoneLabels, index,
}) {
  const [showHeatmap, setShowHeatmap] = useState(true)
  const [refit, setRefit] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const wrapRef = useRef(null)

  const date = sceneDate ?? null

  // Month-stepping navigator. The mockup shows "Apr 2024", but the real
  // granularity is a scene date, so this steps over MONTHS of real acquisitions.
  // A month with no pass is never listed, and stepping into one lands on that
  // month's NEWEST acquisition.
  const months = useMemo(() => {
    const byKey = new Map()
    for (const d of sceneDates) {
      const key = String(d).slice(0, 7)
      const seen = byKey.get(key)
      if (!seen) byKey.set(key, { key, first: d, last: d })
      else seen.last = d
    }
    return [...byKey.values()]
  }, [sceneDates])

  // Located by MONTH, not by exact date. Matching a specific day failed whenever
  // the active scene was not that month's first acquisition: findIndex returned
  // -1, the index fell back to 0, and the stepper silently disabled itself.
  const monthIdx = (() => {
    const i = months.findIndex((m) => m.key === String(date ?? '').slice(0, 7))
    return i < 0 ? 0 : i
  })()

  const step = (delta) => {
    const next = Math.min(months.length - 1, Math.max(0, monthIdx + delta))
    const target = months[next]
    if (target) onSceneChange(target.last)
  }

  const [heat, setHeat] = useState({ state: 'idle', data: null, error: null })

  // Real per-pixel index heatmap for the active scene, at the real bounds.
  useEffect(() => {
    if (!waterbody || !date) { setHeat({ state: 'idle', data: null, error: null }); return }
    let dead = false
    setHeat({ state: 'loading', data: null, error: null })
    getIndexOverlay(waterbody.id, index, date)
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

  const openTipRef = useRef(null)
  const layerByIdRef = useRef(new Map())

  const onEachFeature = (feature, layer) => {
    const id = feature.properties.id
    layerByIdRef.current.set(id, layer)

    layer.on({
      mouseover: (e) => {
        if (openTipRef.current && openTipRef.current !== e.target) {
          openTipRef.current.closeTooltip()
        }
        e.target.setStyle({ weight: 2, color: '#38bdf8', fillOpacity: 0.12 })
        e.target.bringToFront?.()
        e.target.bindTooltip(
          `${zoneShort(id, zoneLabels)} · ${id}`,
          { className: 'zone-tip', sticky: false, direction: 'top' },
        )
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
        e.target.closeTooltip()
        if (openTipRef.current === e.target) openTipRef.current = null
        onSelectZone(id)
      },
    })
  }

  // Single source of truth for the selected zone. Restyle exactly two layers
  // rather than remounting all 478 — remounting destroyed the DOM the user had
  // just clicked and made selection feel broken.
  const styleForId = (id) => {
    const selected = id === selectedZoneId
    return {
      color: selected ? '#38bdf8' : 'rgba(125, 211, 252, 0.55)',
      weight: selected ? 2.5 : 0.6,
      opacity: selected ? 1 : 0.7,
      fillColor: '#38bdf8',
      fillOpacity: selected ? 0.16 : 0.02,
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

  // Memoised: a fresh array here would make FlyTo's effect re-run on every
  // render and yank the view back to the AOI, making the map impossible to pan.
  const bounds = useMemo(
    () => aoiBounds(waterbody?.aoi_geojson),
    [waterbody?.aoi_geojson],
  )
  // Memoised: a fresh array here re-runs the fit effect on every render, which
  // re-fits the view mid-gesture and makes the map impossible to pan.
  const baseCorners = useMemo(() => toCorners(base.data?.bounds), [base.data])
  const heatCorners = useMemo(() => toCorners(heat.data?.bounds), [heat.data])
  const heatReady = showHeatmap && heat.state === 'ready' && heatCorners

  const legendData = heat.state === 'ready' ? heat.data : null
  const activeZone = useMemo(
    () => zones?.find((z) => z.id === selectedZoneId) ?? null,
    [zones, selectedZoneId],
  )

  const toggleFullscreen = () => {
    const el = wrapRef.current
    if (!el) return
    if (document.fullscreenElement) { document.exitFullscreen?.(); setFullscreen(false) } else {
      el.requestFullscreen?.().then(() => setFullscreen(true)).catch(() => setFullscreen(false))
    }
  }

  return (
    <div className={`map-body ${fullscreen ? 'is-fullscreen' : ''}`} ref={wrapRef}>
      <div className="map-canvas">
        {!bounds ? (
          <div className="map-loading">
            {waterbody ? 'Loading water-body bounds…' : 'Search for a water body to begin'}
          </div>
        ) : (
          <MapContainer
            center={[28.56, 77.31]}
            zoom={12}
            scrollWheelZoom
            className="map"
            zoomControl={false}
            attributionControl={false}
          >
            {/*
              Context basemap, always mounted — the GeoVisionAI MapView pattern.
              The composite is a bounded overlay ON TOP of this, not a
              replacement for it: one Sentinel-2 acquisition covers one MGRS
              tile, so ground outside the AOI legitimately has no imagery and
              the basemap is the honest thing to show there.
            */}
            <Pane name="osm" style={{ zIndex: 190 }}>
              <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} maxZoom={19} />
            </Pane>

            {/* Real Sentinel-2 true-colour composite = the basemap. */}
            <Pane name="satellite" style={{ zIndex: 210 }}>
              {base.state === 'ready' && baseCorners && (
                <ImageOverlay url={base.data.image_url} bounds={baseCorners} opacity={1} />
              )}
            </Pane>

            {/* THE HEATMAP: real per-pixel index raster, alpha 0 off water, so
                the colour is clipped to the MNDWI water mask by construction. */}
            <Pane name="heatmap" style={{ zIndex: 320 }}>
              {heatReady && (
                <ImageOverlay url={heat.data.image_url} bounds={heatCorners} opacity={0.78} />
              )}
            </Pane>

            {/* Zone vectors stay on top so they remain clickable. */}
            <Pane name="zones" style={{ zIndex: 430 }}>
              {geojson && (
                <GeoJSON key={waterbody.id} data={geojson} style={styleFor} onEachFeature={onEachFeature} />
              )}
            </Pane>

            {/* The basemap extent is the RENDERED RASTER's bounds, not the AOI's:
                the raster is the imagery, so the view is locked to what actually
                exists. `key` re-runs the fit whenever the scene changes. */}
            <FitToRaster key={`${waterbody?.id}-${sceneDate}`} bounds={baseCorners ?? bounds} />
            <FitRequest bounds={baseCorners ?? bounds} request={refit} />
            <ScaleBar />
            {activeZone && (
              <ZonePin zone={activeZone} label={zoneShort(activeZone.id, zoneLabels)} />
            )}
          </MapContainer>
        )}

        {/* ---- map chrome, all inside the map card ---- */}

        {/* Search: the water-body selector now lives here, not in the sidebar. */}
        <WaterbodySearch
          waterbodies={waterbodies}
          selectedId={waterbody?.id ?? null}
          onSelect={onSelectWaterbody}
        />

        {/* Month navigator over the real scene dates. */}
        <div className="map-date-nav">
          <button
            type="button"
            disabled={monthIdx <= 0}
            onClick={() => step(-1)}
            aria-label="Previous month"
          >
            <CaretLeft size={14} weight="bold" />
          </button>
          <span className="map-date-label">
            {date ? fmtMonth(date) : '—'}
            <span className="map-date-sub mono">{date ? fmtDate(date) : 'no scene'}</span>
          </span>
          <button
            type="button"
            disabled={monthIdx >= months.length - 1}
            onClick={() => step(1)}
            aria-label="Next month"
          >
            <CaretRight size={14} weight="bold" />
          </button>
        </div>

        {/* Left icon rail: layers, locate, chart, expand. The indicator itself
            is not in the rail — it follows the shared `index` state, so the
            legend here always describes exactly what the chart is plotting. */}
        <div className="map-rail">
          <button
            type="button"
            className={`map-rail-btn ${showHeatmap ? 'is-on' : ''}`}
            title={showHeatmap
              ? 'Hide the index overlay (the satellite base stays)'
              : 'Show the index overlay'}
            onClick={() => setShowHeatmap((v) => !v)}
            aria-pressed={showHeatmap}
          >
            <Stack size={15} weight="bold" />
          </button>
          <button
            type="button"
            className="map-rail-btn"
            title="Fit the water body"
            onClick={() => setRefit((n) => n + 1)}
          >
            <Crosshair size={15} weight="bold" />
          </button>
          <button
            type="button"
            className="map-rail-btn"
            title="Scroll to the time series"
            onClick={() => document
              .querySelector('.ts-panel')
              ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
          >
            <ChartLine size={15} weight="bold" />
          </button>
          <button
            type="button"
            className="map-rail-btn"
            title={fullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={toggleFullscreen}
          >
            {fullscreen
              ? <ArrowsIn size={15} weight="bold" />
              : <ArrowsOut size={15} weight="bold" />}
          </button>
        </div>

        {/* Legend for the selected indicator, floating bottom-left. */}
        <div className="map-legend-card">
          <div className="map-legend-title">
            {showHeatmap
              ? (legendData ? (legendData.title ?? INDEX_META[index].label) : INDEX_META[index].label)
              : `${INDEX_META[index].label} — overlay off`}
          </div>

          {showHeatmap && heat.state === 'loading' && <Skeleton lines={1} height={7} />}

          {showHeatmap && legendData && (
            <>
              <div
                className="legend-bar"
                style={{ background: `linear-gradient(to right, ${colorStops(index)})` }}
              />
              <div className="legend-ends mono">
                <span>Low {fmtNum(legendData.vmin, 2)}</span>
                <span>{fmtNum(legendData.vmax, 2)} High</span>
              </div>
            </>
          )}

          {showHeatmap && heat.state === 'unavailable' && (
            <div className="legend-note">
              No {INDEX_META[index].short} overlay for this date —{' '}
              {heat.error?.message ?? 'no usable water pixels after cloud and water masking.'}
            </div>
          )}

          {base.state === 'unavailable' && (
            <div className="legend-note">
              No cached imagery for {date ? fmtDate(date) : 'this date'} — showing the
              context basemap instead. Nothing stale is drawn: a cache miss leaves
              the AOI uncovered rather than substituting another date's image.
            </div>
          )}

          <div className="legend-foot">
            {base.state === 'ready'
              ? `AOI: Sentinel-2 true colour · ${fmtDate(base.data?.date)}`
              : base.state === 'loading'
                ? 'AOI: fetching composite…'
                : 'AOI: no cached composite'}
          </div>
        </div>

        {/* Explicit cache-miss state. A miss must never leave a previous date's
            image sitting over the new date's extent, so this is a first-class
            state rather than a silent blank. */}
        {base.state === 'unavailable' && (
          <div className="map-nostate" role="status">
            <span className="map-nostate-title">
              No cached imagery for {date ? fmtDate(date) : 'this date'}
            </span>
            <span className="map-nostate-note">
              {base.error?.message ?? 'The renderer has no Sentinel-2 acquisition cached for this AOI on this date.'}
            </span>
          </div>
        )}

        {/* Fullscreen: the map owns the viewport while it is active. */}
        <button
          type="button"
          className={`map-expand ${fullscreen ? 'is-active' : ''}`}
          title={fullscreen ? 'Exit full screen' : 'Full screen'}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <ArrowsIn size={14} weight="bold" /> : <ArrowsOut size={14} weight="bold" />}
        </button>
      </div>

      <div className="map-foot">
        <div className="map-foot-left mono">
          {loadingZones
            ? 'loading zone grid…'
            : zonesError
              ? null
              : zones?.length
                ? `${zones.length} real zones cached · ${selectedZoneId ?? 'none'} selected`
                : 'no zone geometry cached'}
          {zonesError ? <ErrorNote error={zonesError} /> : null}
        </div>
        <div className="map-foot-right mono">
          {base.state === 'ready' && base.data?.scene_id
            ? `S2 ${String(base.data.scene_id).split('/').pop()?.slice(0, 22)}`
            : null}
          {showHeatmap
            ? (heatReady && heat.data?.scene_id
              ? ` + ${INDEX_META[index].short} overlay`
              : ' + no index overlay')
            : ' + overlay off'}
        </div>
      </div>
    </div>
  )
}

/** Water-body search + combobox. Selection drives the whole dashboard. */
function WaterbodySearch({ waterbodies, selectedId, onSelect }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const boxRef = useRef(null)

  const term = q.trim().toLowerCase()
  const results = (waterbodies ?? []).filter((w) =>
    !term || w.name.toLowerCase().includes(term) || String(w.id).toLowerCase().includes(term))

  useEffect(() => {
    const onDown = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const pick = (w) => {
    if (!w) return
    onSelect(w.id)
    setQ('')
    setOpen(false)
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { setOpen(true); setCursor((c) => Math.min(results.length - 1, c + 1)) }
    else if (e.key === 'ArrowUp') { setCursor((c) => Math.max(0, c - 1)) }
    else if (e.key === 'Enter') { pick(results[cursor]) }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  return (
    <div className="map-search" ref={boxRef}>
      <MagnifyingGlass size={14} weight="bold" className="map-search-icon" />
      <input
        type="search"
        value={q}
        placeholder="Search water body…"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setCursor(0) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="Search water bodies"
      />
      {open && (
        <ul className="map-search-results" role="listbox">
          {results.length === 0 && <li className="map-search-empty">No water body matches “{q}”.</li>}
          {results.map((w, i) => (
            <li key={w.id}>
              <button
                type="button"
                role="option"
                aria-selected={selectedId === w.id}
                className={`map-search-item ${i === cursor ? 'is-cursor' : ''} ${selectedId === w.id ? 'is-active' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(w)}
              >
                <span className="map-search-name">{w.name}</span>
                <span className="map-search-id mono">{w.id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
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
