/**
 * AquaSentinel dashboard.
 *
 * Data flow, all from real backend endpoints (UI_DATA_MAP.md):
 *   /health                     -> GEE chip (with the specific failure reason)
 *   /waterbodies                -> sidebar list
 *   /waterbodies/-/summary      -> KPI strip
 *   /waterbodies/{id}/stats     -> real scene dates, area, monitoring span
 *   /waterbodies/{id}/zones     -> real zone geometry for the map
 *   /waterbodies/{id}/timeseries-> per-zone observations + baseline band
 *   /alerts?waterbody_id=       -> real alerts (computed on demand)
 *
 * Selecting a zone is the single most important interaction: it drives the map
 * highlight, the indicator tiles, the time series and the before/after pair.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Broadcast } from '@phosphor-icons/react'
import {
  getHealth, getSummary, getWaterbodies, getZones, getWaterbodyStats,
  getTimeseries, getAlerts,
} from './api/client.js'
import { Sidebar } from './components/Sidebar.jsx'
import { KpiStrip, GeeStatus } from './components/KpiStrip.jsx'
import { MapPanel } from './components/MapPanel.jsx'
import { DetailPanel } from './components/DetailPanel.jsx'
import { IndicatorTiles } from './components/IndicatorTiles.jsx'
import { TimeSeriesPanel } from './components/TimeSeriesPanel.jsx'
import { BeforeAfterSlider } from './components/BeforeAfterSlider.jsx'
import { Skeleton, ErrorNote } from './components/States.jsx'

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
  const [series, setSeries] = useState(null)
  const [seriesLoading, setSeriesLoading] = useState(false)
  const [seriesError, setSeriesError] = useState(null)
  const [bootError, setBootError] = useState(null)

  const waterbody = useMemo(
    () => waterbodies.find((w) => w.id === selectedId) ?? null,
    [waterbodies, selectedId],
  )
  const stats = selectedId ? statsById[selectedId] : null
  const alerts = selectedId ? (alertsById[selectedId] ?? []) : []

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

  // ---- selected zone: time series ---------------------------------------
  // Guarded by a request sequence, not a `dead` closure flag. The flag version
  // left `seriesLoading` stuck at true whenever the effect was cleaned up before
  // the response arrived, which hangs the panel on a skeleton forever — and
  // happens in normal use when two zones are clicked in quick succession.
  const seriesReqRef = useRef(0)
  useEffect(() => {
    if (!selectedId || !selectedZoneId) {
      seriesReqRef.current += 1
      setSeries(null)
      setSeriesLoading(false)
      return
    }
    const reqId = ++seriesReqRef.current
    setSeriesLoading(true)
    setSeriesError(null)
    getTimeseries(selectedId, selectedZoneId, tsIndex)
      .then((d) => { if (seriesReqRef.current === reqId) setSeries(d?.points ?? null) })
      .catch((e) => { if (seriesReqRef.current === reqId) setSeriesError(e) })
      .finally(() => { if (seriesReqRef.current === reqId) setSeriesLoading(false) })
  }, [selectedId, selectedZoneId, tsIndex])

  // Keep a selected alert only while it still belongs to the water body.
  useEffect(() => {
    if (selectedAlert && !alerts.some((a) => a.id === selectedAlert.id)) {
      setSelectedAlert(null)
    }
  }, [alerts, selectedAlert])

  const onSelectZone = useCallback((zoneId) => setSelectedZoneId(zoneId), [])
  const onSelectAlert = useCallback((a) => setSelectedAlert(a), [])

  // The alert belonging to the selected zone, for the time-series callout.
  // A panel must not claim "no real observations" while the zone grid or the
  // first series request is still in flight — that reads as a data failure when
  // it is just "not loaded yet". Fold both into the loading flag.
  const seriesPending = seriesLoading || zonesLoading || !selectedZoneId

  const zoneAlert = useMemo(
    () => alerts.find((a) => a.zone_id === selectedZoneId) ?? null,
    [alerts, selectedZoneId],
  )
  const activeAlert = selectedAlert ?? zoneAlert
  const latestPoint = useMemo(
    () => (series ?? []).filter((p) => p).slice(-1)[0] ?? null,
    [series],
  )

  return (
    <div className="app">
      <Sidebar
        active={nav}
        onNavigate={setNav}
        waterbodies={waterbodies}
        statsById={statsById}
        alertsById={alertsById}
        selectedId={selectedId}
        onSelect={(id) => { setSelectedId(id); setSelectedAlert(null) }}
      />

      <main className="main">
        {/* Hero / branding wrapper. Purely presentational — every number in the
            KPI strip below it comes from the backend. */}
        <div className="hero">
          <h1 className="hero-tagline">
            Monitor. Detect. <span>Explain.</span>
          </h1>
          <p className="hero-sub">
            Satellite-based water quality and contamination early warning. Every
            index on this dashboard is computed from real Sentinel-2 L2A surface
            reflectance retrieved from Google Earth Engine.
          </p>
          <div className="hero-badges">
            <span className="hero-badge is-real">
              <Broadcast size={11} weight="duotone" /> Powered by Sentinel-2
            </span>
            {summary?.as_of && (
              <span className="hero-badge">
                As of {new Date(`${summary.as_of}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })}
              </span>
            )}
            <span className="hero-badge">No synthetic data</span>
          </div>
        </div>

        <header className="topbar">
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

        <div className="grid">
          <MapPanel
            waterbody={waterbody}
            zones={zones}
            selectedZoneId={selectedZoneId}
            onSelectZone={onSelectZone}
            stats={stats}
            loadingZones={zonesLoading}
            zonesError={zonesError}
          />

          <DetailPanel
            waterbody={waterbody}
            stats={stats}
            loading={!stats && !!selectedId}
            alerts={alerts}
            selectedZoneId={selectedZoneId}
            onSelectAlert={onSelectAlert}
            selectedAlert={selectedAlert}
            series={series}
            seriesLoading={seriesPending}
            seriesError={seriesError}
            index={tsIndex}
            onIndexChange={setTsIndex}
            zoneAlert={zoneAlert}
          />

          <IndicatorTiles latestPoint={latestPoint} loading={seriesPending} />

          <TimeSeriesPanel
            series={series}
            index={tsIndex}
            loading={seriesPending}
            error={seriesError}
            alert={activeAlert}
            onIndexChange={setTsIndex}
          />

          <BeforeAfterSlider alert={activeAlert} />
        </div>
      </main>
    </div>
  )
}
