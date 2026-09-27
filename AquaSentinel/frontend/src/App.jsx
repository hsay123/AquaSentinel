/**
 * AquaSentinel dashboard.
 *
 * LAYOUT — one CSS Grid with six named areas (see styles/app.css):
 *   sidebar | map + stat strip | detail
 *   sidebar | indicators | chart | before/after
 * Nothing is absolutely positioned over the map: every panel is a grid cell.
 *
 * Data flow, all from real backend endpoints (UI_DATA_MAP.md):
 *   /health                     -> GEE chip (with the specific failure reason)
 *   /waterbodies                -> sidebar list
 *   /waterbodies/-/summary      -> KPI strip
 *   /waterbodies/{id}/stats     -> real scene dates, area, monitoring span
 *   /waterbodies/{id}/zones     -> real zone geometry for the map
 *   /waterbodies/{id}/timeseries-> per-zone observations + baseline band
 *   /alerts?waterbody_id=       -> real alerts (computed on demand)
 *   /alerts/evidence            -> real before/after pair for the open alert
 *
 * STATE — `selectedId` (water body) and `selectedZoneId` are the single source
 * of truth, and `tsIndex` is the single active indicator shared by the map
 * overlay, the indicator cards and the chart. Selecting a zone drives the map
 * highlight, the indicator cards, the time series and the before/after pair
 * together.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getHealth, getSummary, getWaterbodies, getZones, getWaterbodyStats,
  getTimeseries, getAlerts, getTrueColorRaster,
} from './api/client.js'
import { buildZoneLabels, zoneName } from './lib/zones.js'
import { Sidebar } from './components/Sidebar.jsx'
import { KpiStrip, GeeStatus } from './components/KpiStrip.jsx'
import { MapPanel } from './components/MapPanel.jsx'
import { DetailPanel } from './components/DetailPanel.jsx'
import { IndicatorTiles } from './components/IndicatorTiles.jsx'
import { TimeSeriesPanel } from './components/TimeSeriesPanel.jsx'
import { BeforeAfterPanel } from './components/BeforeAfterPanel.jsx'
import { ErrorNote } from './components/States.jsx'

/** The three indices the pipeline actually renders (texture_score is None). */
const RENDERED_INDEXES = ['ndti', 'ndci', 'fai']

export default function App() {
  const [health, setHealth] = useState(null)
  const [summary, setSummary] = useState(null)
  const [waterbodies, setWaterbodies] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [selectedZoneId, setSelectedZoneId] = useState(null)
  const [selectedAlert, setSelectedAlert] = useState(null)
  const [tsIndex, setTsIndex] = useState('ndti')
  const [nav, setNav] = useState('dashboard')

  const [zones, setZones] = useState([])
  const [zonesLoading, setZonesLoading] = useState(false)
  const [zonesError, setZonesError] = useState(null)
  const [statsById, setStatsById] = useState({})
  const [alertsById, setAlertsById] = useState({})
  // One time series per index, for the selected zone. The endpoint returns the
  // seasonal baseline for the index it was asked about, so each indicator card
  // needs its own call to report a real z-score instead of "no baseline".
  const [seriesByIndex, setSeriesByIndex] = useState({})
  const [seriesErrors, setSeriesErrors] = useState({})
  const [seriesLoading, setSeriesLoading] = useState(false)
  const [bootError, setBootError] = useState(null)

  // The active scene is dashboard state, not map state: the map draws it, the
  // sidebar's promo thumbnail shows it, and the detail card's cover shows it.
  // One fetch, one truth — otherwise the promo advertises a different
  // acquisition than the map is drawing.
  const [sceneDate, setSceneDate] = useState(null)
  const [base, setBase] = useState({ state: 'idle', data: null, error: null })

  const waterbody = useMemo(
    () => waterbodies.find((w) => w.id === selectedId) ?? null,
    [waterbodies, selectedId],
  )
  const stats = selectedId ? statsById[selectedId] : null
  const alerts = selectedId ? (alertsById[selectedId] ?? []) : []
  const sceneDates = stats?.scene_dates ?? []

  useEffect(() => {
    // Default to the latest real acquisition whenever the body or its cache
    // changes; never to a date the new body has never been imaged on.
    setSceneDate(sceneDates.length ? sceneDates[sceneDates.length - 1] : null)
  }, [selectedId, sceneDates.length])

  useEffect(() => {
    if (!waterbody || !sceneDate) { setBase({ state: 'idle', data: null, error: null }); return }
    let dead = false
    setBase({ state: 'loading', data: null, error: null })
    getTrueColorRaster(waterbody.id, sceneDate)
      .then((d) => { if (!dead) setBase(d ? { state: 'ready', data: d, error: null } : { state: 'unavailable', data: null, error: null }) })
      .catch((e) => {
        if (dead) return
        // Four terminal outcomes, never an open-ended spinner: ready,
        // unavailable (no such acquisition / nothing cached), timeout (retryable),
        // and this catch as a genuine failure. `timedOut` is carried through so
        // the UI can say which one it was.
        setBase({ state: e?.timedOut ? 'timeout' : 'unavailable', data: null, error: e })
      })
    return () => { dead = true }
  }, [waterbody?.id, sceneDate])

  const series = seriesByIndex[tsIndex]?.points ?? null
  const seriesError = seriesErrors[tsIndex] ?? null

  // ---- boot: health, water bodies, summary -------------------------------
  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        const [h, wbs, sum] = await Promise.all([
          getHealth(), getWaterbodies(), getSummary(),
        ])
        if (dead) return
        setHealth(h)
        setWaterbodies(wbs ?? [])
        setSummary(sum)
        if (wbs?.length) setSelectedId(wbs[0].id)
      } catch (e) {
        if (!dead) setBootError(e)
      }
    })()
    return () => { dead = true }
  }, [])

  // ---- per water body: stats (scene dates, area) ------------------------
  // Fetched for EVERY body, not just the selected one. Previously only the
  // selected body's stats were loaded, so the sidebar showed the other body as
  // "area unavailable" forever — which reads as a data failure when it was just
  // never requested.
  useEffect(() => {
    if (waterbodies.length === 0) return
    let dead = false
    Promise.all(
      waterbodies.map((wb) =>
        getWaterbodyStats(wb.id)
          .then((s) => (s ? [wb.id, s] : null))
          .catch(() => null),
      ),
    ).then((pairs) => {
      if (dead) return
      setStatsById((prev) => {
        const next = { ...prev }
        for (const p of pairs) if (p) next[p[0]] = p[1]
        return next
      })
    })
    return () => { dead = true }
  }, [waterbodies])

  // ---- per water body: zone geometry (the map's click targets) -----------
  useEffect(() => {
    if (!selectedId) { setZones([]); setSelectedZoneId(null); return }
    let dead = false
    setZonesLoading(true); setZonesError(null); setZones([])
    // A zone id is scoped to its water body: zone_227 of the Yamuna grid is a
    // different polygon from zone_227 of the Hussain Sagar grid. Keeping the
    // old selection "because the id happens to exist in both" would carry a
    // stale highlight into a body it was never measured for.
    setSelectedZoneId(null)
    getZones(selectedId)
      .then((z) => {
        if (dead) return
        if (z && z.length) {
          setZones(z)
          setSelectedZoneId((cur) => (z.some((x) => x.id === cur) ? cur : z[0].id))
        } else {
          setZonesError(new Error(
            'No zone geometry cached. Run: python -m backend.scripts.precompute'
          ))
        }
      })
      .catch((e) => { if (!dead) setZonesError(e) })
      .finally(() => { if (!dead) setZonesLoading(false) })
    return () => { dead = true }
  }, [selectedId])

  // ---- per water body: real alerts --------------------------------------
  useEffect(() => {
    if (!selectedId) return
    let dead = false
    getAlerts(selectedId)
      .then((a) => { if (!dead) setAlertsById((p) => ({ ...p, [selectedId]: a?.alerts ?? [] })) })
      .catch(() => { if (!dead) setAlertsById((p) => ({ ...p, [selectedId]: [] })) })
    return () => { dead = true }
  }, [selectedId])

  // ---- selected zone: time series, for every rendered index --------------
  // Guarded by a request sequence, not a `dead` closure flag. The flag version
  // left `seriesLoading` stuck at true whenever the effect was cleaned up before
  // the response arrived, which hangs the panel on a skeleton forever — and
  // happens in normal use when two zones are clicked in quick succession.
  const seriesReqRef = useRef(0)
  useEffect(() => {
    if (!selectedId || !selectedZoneId) {
      seriesReqRef.current += 1
      setSeriesByIndex({})
      setSeriesErrors({})
      setSeriesLoading(false)
      return
    }
    const reqId = ++seriesReqRef.current
    setSeriesLoading(true)
    setSeriesByIndex({})
    setSeriesErrors({})
    Promise.all(
      RENDERED_INDEXES.map(async (idx) => {
        try {
          const d = await getTimeseries(selectedId, selectedZoneId, idx)
          return [idx, { points: d?.points ?? null }]
        } catch (e) {
          return [idx, { points: null }, e]
        }
      }),
    ).then((results) => {
      if (seriesReqRef.current !== reqId) return
      const points = {}
      const errors = {}
      for (const [idx, value, err] of results) {
        points[idx] = value
        if (err) errors[idx] = err
      }
      setSeriesByIndex(points)
      setSeriesErrors(errors)
      setSeriesLoading(false)
    })
  }, [selectedId, selectedZoneId])

  // Keep a selected alert only while it still belongs to the water body.
  useEffect(() => {
    if (selectedAlert && !alerts.some((a) => a.id === selectedAlert.id)) {
      setSelectedAlert(null)
    }
  }, [alerts, selectedAlert])

  const onSelectZone = useCallback((zoneId) => setSelectedZoneId(zoneId), [])
  // Selecting an alert also moves the active zone to that alert's zone. The
  // chart and the indicator cards describe ONE zone, so leaving the zone behind
  // would paint a different zone's numbers next to the alert the user just
  // opened. Before/after already follows the alert itself.
  const onSelectAlert = useCallback((a) => {
    setSelectedAlert(a)
    if (a?.zone_id) setSelectedZoneId(a.zone_id)
  }, [])

  // The alert belonging to the selected zone, for the time-series callout.
  // A panel must not claim "no real observations" while the zone grid or the
  // first series request is still in flight — that reads as a data failure when
  // it is just "not loaded yet". Fold both into the loading flag.
  // The zone gate is the single source of truth for "can the analysis panels say
  // anything yet", and it has FOUR terminal outcomes, not two.
  //
  // It used to be `seriesLoading || zonesLoading || !selectedZoneId`. That last
  // clause is a permanent-loading bug: when GET /zones fails (a body with no
  // cached geometry answers 404) `selectedZoneId` stays null forever, so the
  // indicator cards and the chart rendered skeletons indefinitely with no way to
  // reach an error or empty state. Reproduced with the zones route forced to
  // 404: 6 skeletons still on screen at t=22s.
  //
  //   'loading' -> a skeleton is honest
  //   'ready'   -> a zone is selected, panels read the series
  //   'no-zone' -> geometry loaded but the body has no zones (terminal)
  //   'error'   -> the geometry request failed or timed out (terminal)
  const zoneGate = (() => {
    if (zonesLoading) return 'loading'
    if (zonesError) return 'error'
    if (!selectedZoneId) return zones.length === 0 ? 'no-zone' : 'loading'
    return 'ready'
  })()

  // Only 'loading' may ever show a skeleton.
  const seriesPending = zoneGate === 'loading' || seriesLoading

  const zoneAlert = useMemo(
    () => alerts.find((a) => a.zone_id === selectedZoneId) ?? null,
    [alerts, selectedZoneId],
  )
  const activeAlert = selectedAlert ?? zoneAlert

  // The chart plots the SELECTED zone, so its anomaly callout and marker must
  // come from an alert about that same zone. Handing it an explicitly selected
  // alert from a different zone would paint zone A's anomaly on zone B's line.
  const chartAlert = selectedAlert?.zone_id === selectedZoneId ? selectedAlert : zoneAlert

  // Latest real observation per index. Read from that index's OWN series so a
  // card's z-score is never built from another index's baseline.
  const latestByIndex = useMemo(() => {
    const out = {}
    for (const idx of RENDERED_INDEXES) {
      const pts = seriesByIndex[idx]?.points
      out[idx] = (pts ?? []).filter(Boolean).slice(-1)[0] ?? null
    }
    return out
  }, [seriesByIndex])

  // "Zone A3" aliases for the whole grid, derived from the real zone geometry.
  const zoneLabels = useMemo(() => buildZoneLabels(zones), [zones])

  const pointsByIndex = useMemo(() => {
    const out = {}
    for (const idx of RENDERED_INDEXES) out[idx] = seriesByIndex[idx]?.points ?? null
    return out
  }, [seriesByIndex])

  const totalAlerts = useMemo(
    () => Object.values(alertsById).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0),
    [alertsById],
  )

  return (
    /* One CSS Grid, six named areas. Nothing is positioned over the map from
       outside its card: the map is a cell like every other panel, and the
       sidebar is a column. */
    <div className="app">
      <Sidebar
        active={nav}
        onNavigate={setNav}
        alertCount={totalAlerts}
        thumbUrl={base.state === 'ready' ? base.data.image_url : null}
        thumbAlt={waterbody ? `Sentinel-2 true colour, ${waterbody.name}` : 'Sentinel-2'}
      />

      {/* MAP CARD: the stat strip is the card's own header, so it spans the map
          column instead of the whole window. */}
      <section className="panel map-card">
        <header className="stat-strip">
          <KpiStrip
            summary={summary}
            alerts={selectedId ? alerts : []}
            asOf={stats?.as_of}
            loading={!summary && !bootError}
            error={bootError}
          />
          <GeeStatus health={health} />
        </header>

        {bootError && (
          <div className="boot-error">
            <ErrorNote error={bootError} />
            <div className="boot-hint">
              Is the backend running? From the repo root:{' '}
              <span className="mono">uvicorn backend.main:app --reload --port 8000</span>
            </div>
          </div>
        )}

        <MapPanel
          waterbody={waterbody}
          waterbodies={waterbodies}
          onSelectWaterbody={(id) => { setSelectedId(id); setSelectedAlert(null) }}
          zones={zones}
          zoneLabels={zoneLabels}
          selectedZoneId={selectedZoneId}
          onSelectZone={onSelectZone}
          sceneDates={sceneDates}
          sceneDate={sceneDate}
          onSceneChange={setSceneDate}
          base={base}
          loadingZones={zonesLoading}
          zonesError={zonesError}
          index={tsIndex}
        />
      </section>

      <DetailPanel
        waterbody={waterbody}
        stats={stats}
        loading={!stats && !!selectedId}
        alerts={alerts}
        selectedZoneId={selectedZoneId}
        zoneName={zoneName(selectedZoneId, zoneLabels)}
        coverUrl={base.state === 'ready' ? base.data.image_url : null}
        onSelectAlert={onSelectAlert}
        selectedAlert={selectedAlert}
        series={series}
        seriesLoading={seriesPending}
        seriesError={seriesError}
        index={tsIndex}
        onIndexChange={setTsIndex}
        zoneAlert={zoneAlert}
      />

      <IndicatorTiles
        latestByIndex={latestByIndex}
        pointsByIndex={pointsByIndex}
        errors={seriesErrors}
        loading={seriesPending}
        zoneGate={zoneGate}
        zoneError={zonesError}
        activeIndex={tsIndex}
        onSelectIndex={setTsIndex}
        alert={activeAlert}
        zoneId={selectedZoneId}
        zoneLabels={zoneLabels}
        onZoneChange={onSelectZone}
      />

      <TimeSeriesPanel
        series={series}
        index={tsIndex}
        loading={seriesPending}
        zoneGate={zoneGate}
        zoneError={zonesError}
        error={seriesError}
        alert={chartAlert}
        zoneLabel={zoneName(selectedZoneId, zoneLabels)}
        onIndexChange={setTsIndex}
      />

      <BeforeAfterPanel alert={activeAlert} waterbodyId={selectedId} />
    </div>
  )
}
