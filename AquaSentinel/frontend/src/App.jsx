import React, { useState, useEffect, useCallback, useRef } from 'react'
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { format, parseISO } from 'date-fns'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, Area,
  Scatter, Cell
} from 'recharts'

// ============================================================================
// API Client
// ============================================================================
const API_BASE = '/api'

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ============================================================================
// Basemap
// ============================================================================
// OpenStreetMap standard tiles: no API key, no account, no domain allowlist.
// The previous CARTO `light_all` endpoint (basemaps.cartocdn.com) now answers
// every keyless request with a 2 KB "API KEY REQUIRED" watermark tile — the
// same bytes for every z/x/y, so the map looked broken rather than keyless.
// Don't reintroduce a keyed provider here without a loud startup check; see
// SETUP.md § "Basemap".
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

// ============================================================================
// Components
// ============================================================================

// Fix Leaflet marker icons
import L from 'leaflet'
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// Zone grid cell component
function ZoneCell({ zone, onClick, isSelected }) {
  const style = {
    fillColor: zone.severityColor,
    weight: isSelected ? 2 : 1,
    color: isSelected ? '#fff' : '#38C8FF',
    fillOpacity: 0.5,
    opacity: 1,
  }

  return (
    <GeoJSON
      key={zone.id}
      geometry={zone.polygon}
      style={style}
      onClick={() => onClick(zone)}
    />
  )
}

// Water body boundary
function WaterbodyBoundary({ geojson }) {
  return (
    <GeoJSON
      geometry={geojson}
      style={{
        fillColor: '#38C8FF',
        fillOpacity: 0.05,
        color: '#38C8FF',
        weight: 2,
        dashArray: '8, 4',
      }}
    />
  )
}

// Map component with click handling
function MapView({ center, zoom, waterbody, zones, selectedZone, onZoneClick, onMapClick }) {
  const mapRef = useRef(null)

  const handleClick = (e) => {
    if (onMapClick) onMapClick(e.latlng)
  }

  return (
    <MapContainer
      ref={mapRef}
      center={center}
      zoom={zoom}
      scrollWheelZoom={true}
      onClick={handleClick}
      style={{ width: '100%', height: '100%' }}
    >
      <TileLayer
        url={OSM_TILE_URL}
        attribution={OSM_ATTRIBUTION}
        maxZoom={19}
      />
      {waterbody && <WaterbodyBoundary geojson={waterbody.aoi_geojson} />}
      {zones.map(zone => (
        <ZoneCell
          key={zone.id}
          zone={zone}
          onClick={onZoneClick}
          isSelected={selectedZone?.id === zone.id}
        />
      ))}
    </MapContainer>
  )
}

// Status chip
function StatusChip({ status }) {
  const colors = {
    normal: 'var(--color-normal)',
    watch: 'var(--color-watch)',
    alert: 'var(--color-alert)',
  }
  const labels = { normal: 'Normal', watch: 'Watch', alert: 'Alert' }

  return (
    <span
      className="mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 10px',
        borderRadius: 'var(--radius-sm)',
        background: `${colors[status]}20`,
        color: colors[status],
        border: `1px solid ${colors[status]}40`,
        fontSize: '0.7rem',
        fontWeight: 600,
        textTransform: 'uppercase',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors[status] }} />
      {labels[status]}
    </span>
  )
}

// Waterbody list item
function WaterbodyItem({ waterbody, status, isActive, onClick }) {
  return (
    <div
      className={`waterbody-item ${isActive ? 'active' : ''}`}
      onClick={() => onClick(waterbody.id)}
    >
      <div className={`wb-status ${status}`} />
      <div className="wb-info">
        <div className="wb-name">{waterbody.name}</div>
        <div className="wb-meta mono">{waterbody.id}</div>
      </div>
      <StatusChip status={status} />
    </div>
  )
}

// Alert card component (design.md §2.3)
function AlertCard({ alert, onViewTimeseries }) {
  const severityColor = alert.confidence === 'high' ? 'var(--color-alert)' : 'var(--color-watch)'

  return (
    <div className={`alert-card ${alert.confidence}`}>
      <div className="alert-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="mono" style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
            {format(parseISO(alert.date), 'yyyy-MM-dd')}
          </span>
          <span className="mono" style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
            {alert.zone_id}
          </span>
          <span className="mono" style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
            {alert.scene_id?.slice(0, 20)}...
          </span>
        </div>
        <span className={`alert-badge ${alert.confidence}`}>
          {alert.confidence === 'high' ? 'HIGH' : 'NEEDS REVIEW'}
        </span>
      </div>

      <div className="alert-indicators mono">
        {alert.indicators.map((ind, i) => (
          <span key={i} style={{ marginRight: '8px' }}>
            {ind.name.toUpperCase()}{ind.z_score !== null ? ` ${ind.z_score > 0 ? '+' : ''}{ind.z_score.toFixed(1)}σ` : ''}
          </span>
        ))}
        {alert.indicators.filter(i => i.z_score !== null).length} of {alert.indicators.length} indicators agree
      </div>

      <div className="alert-explanation">{alert.explanation}</div>

      <div className="alert-evidence">
        <div className="evidence-thumb" title="Before">
          {alert.evidence.index_map_png_path ? (
            <img src={alert.evidence.index_map_png_path} alt="Before" />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', color: 'var(--text-muted)' }}>Before</div>
          )}
        </div>
        <div className="evidence-thumb" title="After">
          {alert.evidence.index_map_png_path ? (
            <img src={alert.evidence.index_map_png_path} alt="After" />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', color: 'var(--text-muted)' }}>After</div>
          )}
        </div>
      </div>

      <div className="alert-footer">
        <span className={`alert-confidence ${alert.confidence}`}>
          Confidence: {alert.confidence === 'high' ? 'High (statistical)' : 'Needs review (pattern)'}
        </span>
        <button className="view-timeseries-btn" onClick={() => onViewTimeseries(alert)}>
          View time series →
        </button>
      </div>
    </div>
  )
}

// Time series chart for a single index
function IndexChart({ data, indexName, flaggedDate, baselineMean, baselineStd, provisional }) {
  const chartData = data.map(d => ({
    date: format(parseISO(d.date), 'MMM dd'),
    value: d[indexName],
    baselineUpper: baselineMean && baselineStd ? baselineMean + 2 * baselineStd : null,
    baselineLower: baselineMean && baselineStd ? baselineMean - 2 * baselineStd : null,
    baselineMean: baselineMean || null,
    isFlagged: d.date === flaggedDate,
  })).filter(d => d.value !== null && d.value !== undefined)

  if (chartData.length === 0) {
    return (
      <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
        No data for {indexName.toUpperCase()}
      </div>
    )
  }

  const flaggedPoint = chartData.find(d => d.isFlagged)

  return (
    <div className="timeseries-chart-container">
      <div className="chart-title">{indexName.toUpperCase()} — Zone Time Series</div>
      {provisional && <div className="provisional-badge">Provisional baseline (n &lt; 18 months)</div>}
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2A3A4A" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
            axisLine={{ stroke: '#2A3A4A' }}
            tickLine={{ stroke: '#2A3A4A' }}
          />
          <YAxis
            tick={{ fill: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-focus)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-lg)',
            }}
            labelStyle={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            itemStyle={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
          <Legend
            wrapperStyle={{ paddingTop: 8 }}
            iconSize={10}
            layout="horizontal"
            align="center"
          />
          {/* Baseline band */}
          {baselineMean && baselineStd && (
            <Area
              type="monotone"
              dataKey="baselineUpper"
              stackId="baseline"
              stroke="none"
              fill="var(--color-baseline)"
              fillOpacity={0.15}
            />
          )}
          <Area
            type="monotone"
            dataKey="baselineLower"
            stackId="baseline"
            stroke="none"
            fill="#0A0F16"
            fillOpacity={1}
          />
          {/* Baseline mean line */}
          {baselineMean && (
            <Line
              type="monotone"
              dataKey="baselineMean"
              stroke="var(--color-baseline)"
              strokeDasharray="4 4"
              strokeWidth={1}
              dot={false}
              legendType="line"
              name="Baseline ±2σ"
            />
          )}
          {/* Observations */}
          <Line
            type="monotone"
            dataKey="value"
            stroke="#888"
            strokeWidth={1.5}
            dot={false}
            legendType="line"
            name="Observations"
            connectNulls={true}
          />
          {/* Flagged point */}
          {flaggedPoint && (
            <Scatter
              data={[{ x: chartData.indexOf(flaggedPoint), y: flaggedPoint.value }]}
              fill="var(--color-alert)"
              name="Flagged"
              legendType="circle"
            >
              <Cell r={6} fill="var(--color-alert)" stroke="#fff" strokeWidth={2} />
            </Scatter>
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// Time series panel (design.md §2.2)
function TimeSeriesPanel({ zone, waterbodyId, alerts, onClose, onViewAlert }) {
  const [tsData, setTsData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      setLoading(true)
      try {
        const indices = ['ndti', 'ndci', 'fai', 'texture_score']
        const results = await Promise.all(
          indices.map(idx =>
            apiGet(`/waterbodies/${waterbodyId}/timeseries?zone_id=${zone.id}&index=${idx}`)
          )
        )
        // Merge all indices into single data array by date
        const merged = {}
        results.forEach((res, i) => {
          res.points.forEach(p => {
            const key = p.date
            if (!merged[key]) merged[key] = { date: key }
            merged[key][results[i].index] = p[ind]
            merged[key].baselineMean = p.baseline_mean
            merged[key].baselineStd = p.baseline_std
            merged[key].isFlagged = p.is_flagged
          })
        })
        setTsData(Object.values(merged).sort((a, b) => a.date.localeCompare(b.date)))
      } catch (e) {
        console.error('Failed to fetch time series:', e)
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [waterbodyId, zone.id])

  if (loading) {
    return (
      <div className="timeseries-panel open">
        <div className="timeseries-header">
          <h2 className="timeseries-title">Loading...</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="loading-overlay" style={{ position: 'relative', inset: 'auto', background: 'none', backdropFilter: 'none' }}>
          <div className="loading-spinner" />
          <div className="loading-text">Fetching time series...</div>
        </div>
      </div>
    )
  }

  const flaggedDate = alerts.find(a => a.zone_id === zone.id)?.date

  return (
    <div className="timeseries-panel open">
      <div className="timeseries-header">
        <h2 className="timeseries-title">
          {zone.id} — {waterbodyId}
        </h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>
      <div className="timeseries-content">
        {tsData && [
          'ndti', 'ndci', 'fai', 'texture_score'
        ].map(idx => (
          <IndexChart
            key={idx}
            data={tsData}
            indexName={idx}
            flaggedDate={flaggedDate}
            baselineMean={tsData[0]?.baselineMean}
            baselineStd={tsData[0]?.baselineStd}
            provisional={false}
          />
        ))}
      </div>
    </div>
  )
}

// Alert detail panel (design.md §2.3)
function AlertDetailPanel({ alert, onClose }) {
  if (!alert) return null

  return (
    <div className={`alert-detail ${alert.confidence}`} style={{ maxWidth: 600, margin: '0 auto' }}>
      <div className="alert-detail-header">
        <div>
          <div className="alert-detail-title">
            ALERT · {alert.zone_id} · {format(parseISO(alert.date), 'yyyy-MM-dd')}
          </div>
          <div className="alert-detail-meta">
            <span className="mono">Scene: {alert.scene_id}</span>
            <span className="mono">Severity: {alert.severity.toFixed(2)}</span>
          </div>
        </div>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      <div className="alert-indicators-row">
        {alert.indicators.map((ind, i) => (
          <span key={i} className={`indicator-chip ${ind.name}`}>
            {ind.name.toUpperCase()}
            {ind.z_score !== null && (
              <>
                {' '}{ind.z_score > 0 ? '+' : ''}{ind.z_score.toFixed(1)}σ
              </>
            )}
          </span>
        ))}
      </div>

      <div className="alert-explanation-text">
        {alert.explanation}
      </div>

      <div className="alert-evidence-grid">
        <div className="evidence-panel">
          <div className="evidence-panel-title">Before (Baseline)</div>
          {alert.evidence.index_map_png_path ? (
            <img className="evidence-image" src={alert.evidence.index_map_png_path} alt="Before" />
          ) : (
            <div style={{ aspectRatio: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>No baseline image</div>
          )}
        </div>
        <div className="evidence-panel">
          <div className="evidence-panel-title">After (Flagged)</div>
          {alert.evidence.chart_png_path ? (
            <img className="evidence-image" src={alert.evidence.chart_png_path} alt="Chart" />
          ) : (
            <div style={{ aspectRatio: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>No chart</div>
          )}
        </div>
      </div>

      <div className="alert-detail-footer">
        <span className={`alert-confidence ${alert.confidence}`}>
          Confidence: {alert.confidence === 'high' ? 'High (statistical)' : 'Needs review (pattern)'}
        </span>
        <span className="mono" style={{ fontSize: '0.7rem' }}>
          Generated: {alert.generated ? 'LLM polished' : 'Template'}
        </span>
      </div>
    </div>
  )
}

// Onboarding modal (design.md §2.4)
function OnboardingModal({ isOpen, onClose, onSubmit }) {
  if (!isOpen) return null

  const [form, setForm] = useState({ name: '', geojson: '', dateRange: '' })

  const handleSubmit = (e) => {
    e.preventDefault()
    try {
      const geojson = JSON.parse(form.geojson)
      onSubmit({ ...form, geojson })
      onClose()
    } catch (e) {
      alert('Invalid GeoJSON')
    }
  }

  return (
    <div className="onboarding-modal" onClick={onClose}>
      <div className="onboarding-content" onClick={e => e.stopPropagation()}>
        <h2 style={{ marginBottom: 'var(--space-4)', fontWeight: 600 }}>Add Water Body</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Name</label>
            <input
              className="form-input"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="e.g., Lake Erie Western Basin"
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">AOI GeoJSON</label>
            <textarea
              className="form-textarea"
              value={form.geojson}
              onChange={e => setForm({ ...form, geojson: e.target.value })}
              placeholder='{ "type": "Polygon", "coordinates": [[[lon, lat], ...]] }'
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">Date Range (YYYY-MM-DD to YYYY-MM-DD)</label>
            <input
              className="form-input"
              value={form.dateRange}
              onChange={e => setForm({ ...form, dateRange: e.target.value })}
              placeholder="2023-01-01 to 2024-01-01"
              required
            />
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Add Water Body</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// GEE status chip. A bare "GEE Offline" is unactionable: "no credentials on
// this machine", "the key was revoked" and "this network can't reach
// earthengine.googleapis.com" are three different problems. The backend
// classifies the failure (see backend/gee_client.py) and the specific reason
// plus the fix is shown here on hover / click so a teammate can self-diagnose
// without reading backend logs.
const GEE_STATUS_LABEL = {
  ok: 'GEE Connected',
  no_credentials: 'GEE Offline — no credentials',
  service_account_misconfigured: 'GEE Offline — service account misconfigured',
  invalid_credentials: 'GEE Offline — credentials rejected',
  project_denied: 'GEE Offline — no project access',
  network_unreachable: 'GEE Offline — network unreachable',
  network_timeout: 'GEE Offline — GEE timed out',
  unknown: 'GEE Offline',
}

function GeeStatus({ health }) {
  const [open, setOpen] = useState(false)
  if (!health) {
    return <div className="gee-status checking">◌ Checking GEE…</div>
  }

  const ok = health.gee_connected
  const status = health.gee_status || (ok ? 'ok' : 'unknown')
  const label = ok ? GEE_STATUS_LABEL.ok : (GEE_STATUS_LABEL[status] || GEE_STATUS_LABEL.unknown)
  const tooltip = [health.gee_message, health.gee_fix && `Fix: ${health.gee_fix}`]
    .filter(Boolean)
    .join('\n')

  return (
    <>
      <div
        className={`gee-status ${ok ? 'ok' : 'degraded'}`}
        title={tooltip || undefined}
        onClick={() => !ok && setOpen(!open)}
        style={{ cursor: ok ? 'default' : 'pointer' }}
      >
        {ok ? '●' : '○'} {label}
      </div>
      {open && !ok && (
        <div className="gee-detail floating-panel">
          <div className="gee-detail-title">Earth Engine unavailable</div>
          <div className="gee-detail-reason">{health.gee_message}</div>
          {health.gee_fix && <div className="gee-detail-fix">{health.gee_fix}</div>}
          <div className="gee-detail-meta mono">
            project: {health.gee_project || '—'} · auth: {health.gee_auth_mode || 'none'}
          </div>
          <div className="gee-detail-meta">Full setup instructions: SETUP.md</div>
        </div>
      )}
    </>
  )
}

// Main App
function App() {
  const [waterbodies, setWaterbodies] = useState([])
  const [selectedWaterbody, setSelectedWaterbody] = useState(null)
  const [zones, setZones] = useState([])
  const [alerts, setAlerts] = useState([])
  const [selectedZone, setSelectedZone] = useState(null)
  const [selectedAlert, setSelectedAlert] = useState(null)
  const [showTimeseries, setShowTimeseries] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [health, setHealth] = useState(null)
  const [error, setError] = useState(null)
  const [mapCenter, setMapCenter] = useState([20, 78])
  const [mapZoom, setMapZoom] = useState(5)

  // Load waterbodies + backend health on mount
  useEffect(() => {
    async function load() {
      try {
        const [wbRes, healthRes] = await Promise.all([
          apiGet('/waterbodies'),
          apiGet('/health'),
        ])
        setWaterbodies(wbRes)
        setHealth(healthRes)
        if (wbRes.length > 0) {
          setSelectedWaterbody(wbRes[0])
        }
      } catch (e) {
        setError(
          `Failed to load waterbodies: ${e.message || e}. ` +
          'Is the backend running on port 8000? (From the repo root: uvicorn backend.main:app --reload --port 8000)'
        )
        console.error(e)
      }
    }
    load()
  }, [])

  // Load zones and alerts when waterbody changes
  useEffect(() => {
    if (!selectedWaterbody) return

    async function load() {
      try {
        // Update map center to waterbody centroid
        const coords = selectedWaterbody.aoi_geojson.coordinates[0]
        const lats = coords.map(c => c[1])
        const lons = coords.map(c => c[0])
        const center = [
          (Math.max(...lats) + Math.min(...lats)) / 2,
          (Math.max(...lons) + Math.min(...lons)) / 2,
        ]
        setMapCenter(center)
        setMapZoom(12)

        // For demo, we'll use mock zones since zones endpoint not fully implemented
        // In production, fetch from /waterbodies/{id}/zones
        const mockZones = [
          { id: 'zone_0', polygon: selectedWaterbody.aoi_geojson, severityColor: 'var(--color-normal)', centroid_lat: center[0], centroid_lon: center[1] },
          { id: 'zone_1', polygon: selectedWaterbody.aoi_geojson, severityColor: 'var(--color-watch)', centroid_lat: center[0] + 0.01, centroid_lon: center[1] + 0.01 },
          { id: 'zone_2', polygon: selectedWaterbody.aoi_geojson, severityColor: 'var(--color-alert)', centroid_lat: center[0] - 0.01, centroid_lon: center[1] - 0.01 },
        ]
        setZones(mockZones)

        // Fetch alerts
        const alertRes = await apiGet(`/alerts?waterbody_id=${selectedWaterbody.id}`)
        setAlerts(alertRes.alerts || [])
      } catch (e) {
        console.error('Failed to load zones/alerts:', e)
      }
    }
    load()
  }, [selectedWaterbody])

  // Determine waterbody status from alerts
  const getWaterbodyStatus = (wbId) => {
    const wbAlerts = alerts.filter(a => a.waterbody_id === wbId)
    if (wbAlerts.some(a => a.confidence === 'high')) return 'alert'
    if (wbAlerts.some(a => a.confidence === 'needs_review')) return 'watch'
    return 'normal'
  }

  const handleZoneClick = (zone) => {
    setSelectedZone(zone)
    setShowTimeseries(true)
  }

  const handleViewTimeseries = (alert) => {
    const zone = zones.find(z => z.id === alert.zone_id)
    if (zone) {
      setSelectedZone(zone)
      setShowTimeseries(true)
    }
  }

  const handleMapClick = (latlng) => {
    // For onboarding - could add a marker
    console.log('Map clicked:', latlng)
  }

  return (
    <div className="app">
      {/* Map Stage */}
      <div className="map-stage">
        <MapView
          center={mapCenter}
          zoom={mapZoom}
          waterbody={selectedWaterbody}
          zones={zones}
          selectedZone={selectedZone}
          onZoneClick={handleZoneClick}
          onMapClick={handleMapClick}
        />
      </div>

      {/* Top Bar */}
      <div className="top-bar floating-panel">
        <div className="brand">
          <div className="brand-icon">🌊</div>
          <span>AquaSentinel</span>
        </div>
        <GeeStatus health={health} />
      </div>

      {/* Location Chip */}
      {selectedWaterbody && (
        <div className="location-chip floating-panel">
          <div className="location-name">{selectedWaterbody.name}</div>
          <div className="location-coords mono">
            {mapCenter[0].toFixed(4)}°N, {mapCenter[1].toFixed(4)}°E
          </div>
        </div>
      )}

      {/* Left Sidebar */}
      <div className="sidebar floating-panel">
        <div className="sidebar-section">
          <div className="sidebar-title">Monitored Water Bodies</div>
          <div className="waterbody-list">
            {waterbodies.map(wb => (
              <WaterbodyItem
                key={wb.id}
                waterbody={wb}
                status={getWaterbodyStatus(wb.id)}
                isActive={selectedWaterbody?.id === wb.id}
                onClick={setSelectedWaterbody}
              />
            ))}
            <button
              className="btn btn-secondary"
              style={{ marginTop: 'var(--space-2)', justifyContent: 'center' }}
              onClick={() => setShowOnboarding(true)}
            >
              + Add Water Body
            </button>
          </div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-title">Alert Feed</div>
          <div className="alert-feed">
            {alerts.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: 'var(--space-4)' }}>
                No alerts for {selectedWaterbody?.name || 'selected water body'}
              </div>
            ) : (
              alerts.slice(0, 10).map(alert => (
                <AlertCard
                  key={alert.id}
                  alert={alert}
                  onViewTimeseries={handleViewTimeseries}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Time Series Panel */}
      {showTimeseries && selectedZone && (
        <TimeSeriesPanel
          zone={selectedZone}
          waterbodyId={selectedWaterbody?.id}
          alerts={alerts}
          onClose={() => { setShowTimeseries(false); setSelectedZone(null); }}
        />
      )}

      {/* Alert Detail Panel */}
      {selectedAlert && (
        <div className="onboarding-modal" onClick={() => setSelectedAlert(null)}>
          <AlertDetailPanel
            alert={selectedAlert}
            onClose={() => setSelectedAlert(null)}
          />
        </div>
      )}

      {/* Onboarding Modal */}
      <OnboardingModal
        isOpen={showOnboarding}
        onClose={() => setShowOnboarding(false)}
        onSubmit={async (data) => {
          try {
            await apiPost('/waterbodies', data)
            // Reload waterbodies
            const wbRes = await apiGet('/waterbodies')
            setWaterbodies(wbRes)
            setShowOnboarding(false)
          } catch (e) {
            alert('Failed to add water body')
          }
        }}
      />

      {/* Persistent Boundary Banner (design.md §2.1 - non-dismissable) */}
      <div className="command-center">
        <div className="boundary-banner">
          <div className="boundary-text">
            <svg className="boundary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            AquaSentinel flags optically observable satellite anomalies to prioritize sites for ground investigation.
            It does not replace laboratory water testing.
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="error-banner">
          {error}
        </div>
      )}
    </div>
  )
}

export default App