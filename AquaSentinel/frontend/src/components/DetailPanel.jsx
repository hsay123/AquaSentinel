/**
 * Right detail panel for the selected water body.
 *
 * Stats are real and computed (see UI_DATA_MAP.md §B):
 *   Area            -> shapely area of the MNDWI water mask, UTM-projected
 *   Monitoring Since-> min(real Observation.date)
 *   Zones / Scenes  -> counts from the store
 *   Mean depth      -> NOT reported: bathymetry is not produced by this
 *                      pipeline, so the row is shown as unavailable rather than
 *                      filled with an invented figure.
 *
 * Tabs: Overview / Time Series / Alerts / Gallery / Details. Gallery reports
 * unavailable rather than showing stock imagery.
 */

import { useState } from 'react'
import { MapPin, Ruler, CalendarBlank, GridFour, Camera } from '@phosphor-icons/react'
import {
  fmtArea, fmtDate, fmtNum, severityOf, worstConfidence,
} from '../lib/format.js'
import { Skeleton, Unavailable, EmptyState } from './States.jsx'

const TABS = ['Overview', 'Time Series', 'Alerts', 'Gallery', 'Details']

function StatRow({ icon: Icon, label, value, note }) {
  return (
    <div className="stat-row">
      <Icon size={14} weight="duotone" className="stat-icon" />
      <div className="stat-body">
        <div className="stat-label">{label}</div>
        <div className="stat-value mono">{value}</div>
        {note && <div className="stat-note">{note}</div>}
      </div>
    </div>
  )
}

export function DetailPanel({
  waterbody, stats, loading, alerts, selectedZoneId, onSelectAlert, selectedAlert,
}) {
  const [tab, setTab] = useState('Overview')
  if (!waterbody) {
    return (
      <section className="panel detail-panel">
        <div className="detail-empty">Select a water body.</div>
      </section>
    )
  }

  const conf = worstConfidence(alerts)
  const sev = severityOf(conf)

  return (
    <section className="panel detail-panel">
      <div className="detail-head">
        <div className="detail-title-row">
          <h2 className="detail-name">{waterbody.name}</h2>
          <span className="detail-badge" style={{ color: sev.color, borderColor: sev.color }}>
            {sev.tier}
          </span>
        </div>
        <div className="detail-loc mono">
          <MapPin size={12} weight="duotone" />
          {waterbody.id}
        </div>
        {waterbody.description && (
          <p className="detail-desc">{waterbody.description}</p>
        )}
      </div>

      <div className="detail-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? 'is-active' : ''}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="detail-body">
        {tab === 'Overview' && (
          loading ? <Skeleton lines={5} height={14} /> : (
            <>
              <StatRow
                icon={Ruler}
                label="Water area"
                value={fmtArea(stats?.water_area_km2)}
                note={stats?.water_area_source ?? 'No cached geometry — run the precompute'}
              />
              <StatRow
                icon={CalendarBlank}
                label="Monitoring since"
                value={fmtDate(stats?.monitoring_since)}
                note={`${stats?.span_days ?? '—'} days · ${stats?.scene_count ?? 0} real scenes`}
              />
              <StatRow
                icon={GridFour}
                label="Zones"
                value={stats?.zone_count ?? '—'}
                note={
                  stats?.zones_with_geometry
                    ? `${stats.zones_with_geometry} with cached geometry${selectedZoneId ? ` · ${selectedZoneId} selected` : ''}`
                    : 'no geometry cached'
                }
              />
              <StatRow
                icon={Ruler}
                label="Mean depth"
                value="—"
                note={stats?.mean_depth_note ?? 'Not produced by this pipeline'}
              />
            </>
          )
        )}

        {tab === 'Time Series' && (
          stats?.scene_count ? (
            <div className="scene-date-list">
              <div className="scene-date-head">
                {stats.scene_count} real acquisition dates (newest first)
              </div>
              {stats.scene_dates.slice().reverse().slice(0, 24).map((d) => (
                <div key={d} className="scene-date mono">{fmtDate(d)}</div>
              ))}
            </div>
          ) : (
            <EmptyState title="No cached time series" detail="Run the precompute for this water body." />
          )
        )}

        {tab === 'Alerts' && (
          !alerts || alerts.length === 0 ? (
            <EmptyState
              title="No alerts for this water body"
              detail="Anomaly detection found no flagged zone in the cached window."
            />
          ) : (
            <div className="alert-list">
              {alerts.slice(0, 20).map((a) => {
                const s = severityOf(a.confidence)
                const z = a.indicators?.find((i) => i.z_score != null)
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`alert-item ${selectedAlert?.id === a.id ? 'is-active' : ''}`}
                    onClick={() => onSelectAlert(a)}
                  >
                    <div className="alert-item-head">
                      <span className="alert-tier" style={{ color: s.color }}>{s.tier}</span>
                      <span className="alert-date mono">{fmtDate(a.date)}</span>
                      <span className="alert-zone mono">{a.zone_id}</span>
                    </div>
                    <div className="alert-item-text">{a.explanation}</div>
                    {z && (
                      <div className="alert-item-z mono">
                        {z.name.toUpperCase()} {z.z_score >= 0 ? '+' : ''}{fmtNum(z.z_score, 2)}σ
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )
        )}

        {tab === 'Gallery' && (
          <Unavailable
            title="Gallery not built"
            reason="Thumbnails would be cropped true-colour composites per water body/date. The map panel already serves the full real composite, so no separate gallery is wired up."
            source="backend/pipeline/render.py::render_true_color"
          />
        )}

        {tab === 'Details' && (
          <>
            <StatRow icon={Camera} label="Reference scene" value={stats?.reference_scene_id ? String(stats.reference_scene_id).split('/').pop() : '—'} note="Scene used to build the cached zone grid" />
            <StatRow icon={GridFour} label="Otsu water threshold" value={stats?.otsu_threshold != null ? fmtNum(stats.otsu_threshold, 4) : '—'} note="Per-scene Otsu on MNDWI" />
            <StatRow icon={Ruler} label="Water fraction" value={stats?.water_fraction != null ? `${(stats.water_fraction * 100).toFixed(2)}%` : '—'} note="Share of the AOI classified as water" />
            <StatRow icon={CalendarBlank} label="Observations" value={stats?.observation_count ?? '—'} note="Cached zone-observations in Parquet" />
          </>
        )}
      </div>
    </section>
  )
}
