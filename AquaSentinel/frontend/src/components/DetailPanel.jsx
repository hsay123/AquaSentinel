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

import { useEffect, useMemo, useState } from 'react'
import {
  MapPin, Ruler, CalendarBlank, GridFour, Camera, Siren, Warning, ArrowRight, CaretRight,
} from '@phosphor-icons/react'
import {
  fmtArea, fmtDate, fmtNum, severityOf, worstConfidence,
} from '../lib/format.js'
import { getEvidence } from '../lib/evidence.js'
import { zoneName } from '../lib/zones.js'
import { Skeleton, Unavailable, EmptyState } from './States.jsx'
import { TimeSeriesChart } from './TimeSeriesChart.jsx'

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

/**
 * The three most recent alerts for this water body, in the Overview tab.
 * Same records the Alerts tab draws from — the feed is already sorted
 * newest-first — so a row can be clicked to select the alert, which drives the
 * chart, the indicator cards and the before/after pair together.
 *
 * Each row carries a 40x40 satellite thumbnail: the REAL true-colour composite
 * the renderer produced for that alert. Only the top row is fetched eagerly, and
 * only one at a time — each miss is a ~35s Earth Engine render, so queueing all
 * three on page load would make the card feel broken for a minute. The rest fill
 * in when the user selects them, via the shared evidence cache that the
 * Before/After panel also uses, so no pair is ever rendered twice. Until then a
 * row shows its severity icon: an honest gap, never a placeholder picture.
 */
function RecentAlerts({ alerts, selectedAlert, onSelectAlert, onViewAll, waterbodyId }) {
  const [thumbs, setThumbs] = useState({})
  const top = alerts?.[0]
  const wanted = useMemo(
    () => (top && !thumbs[top.id] ? top : null),
    [top, thumbs],
  )

  useEffect(() => {
    if (!wanted || !waterbodyId) return undefined
    let dead = false
    getEvidence(waterbodyId, wanted.zone_id, wanted.date)
      .then((d) => {
        if (dead) return
        setThumbs((prev) => (
          prev[wanted.id] ? prev : { ...prev, [wanted.id]: d?.after_image_url ?? null }
        ))
      })
    return () => { dead = true }
  }, [wanted, waterbodyId])

  // The selected alert's own pair is usually already cached by Before/After.
  useEffect(() => {
    const a = selectedAlert
    if (!a || !waterbodyId || thumbs[a.id]) return undefined
    let dead = false
    getEvidence(waterbodyId, a.zone_id, a.date)
      .then((d) => {
        if (dead) return
        setThumbs((prev) => (prev[a.id] ? prev : { ...prev, [a.id]: d?.after_image_url ?? null }))
      })
    return () => { dead = true }
  }, [selectedAlert, waterbodyId, thumbs])

  if (!alerts?.length) {
    return (
      <div className="recent-block">
        <div className="recent-head">
          <span className="recent-title">Recent Alerts</span>
        </div>
        <EmptyState
          title="No alerts in the cached window"
          detail="Anomaly detection found no flagged zone for this water body."
        />
      </div>
    )
  }

  return (
    <div className="recent-block">
      <div className="recent-head">
        <span className="recent-title">Recent Alerts</span>
        <button type="button" className="view-all" onClick={onViewAll}>
          View all <ArrowRight size={11} weight="bold" />
        </button>
      </div>

      <ul className="recent-list">
        {alerts.slice(0, 3).map((a) => {
          const s = severityOf(a.confidence)
          const z = a.indicators?.find((i) => i.z_score != null)
          const Icon = a.confidence === 'high' ? Warning : Siren
          const thumb = thumbs[a.id]
          return (
            <li key={a.id}>
              <button
                type="button"
                className={`recent-item ${selectedAlert?.id === a.id ? 'is-active' : ''}`}
                onClick={() => onSelectAlert(a)}
                title={a.explanation}
              >
                <span className="recent-thumb">
                  {thumb
                    ? <img src={thumb} alt={`True colour on ${fmtDate(a.date)}`} loading="lazy" />
                    : <Icon size={15} weight="duotone" style={{ color: s.color }} />}
                </span>
                <span className="recent-body">
                  <span className="recent-line">
                    <span className="recent-alert-title">
                      {z ? `${z.name.toUpperCase()} anomaly` : 'Anomaly'}
                    </span>
                    <span className="recent-pill" style={{ color: s.color, borderColor: s.color }}>
                      {s.tier}
                    </span>
                  </span>
                  <span className="recent-meta mono">
                    {a.zone_id} · {fmtDate(a.date)}
                    {z ? ` · ${z.z_score >= 0 ? '+' : ''}${fmtNum(z.z_score, 2)}σ` : ''}
                  </span>
                </span>
                <CaretRight size={12} weight="bold" className="recent-chevron" />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function DetailPanel({
  waterbody, stats, loading, alerts, selectedZoneId, zoneName, coverUrl,
  onSelectAlert, selectedAlert, series, seriesLoading, seriesError,
  index, onIndexChange, zoneAlert,
}) {
  const [tab, setTab] = useState('Overview')
  if (!waterbody) {
    return (
      <section className="panel detail-panel">
        <div className="detail-empty">Search for a water body to begin.</div>
      </section>
    )
  }

  // A body with no cached scenes must not present a confident "Low" badge:
  // that implies "checked, fine" rather than "not analysed yet".
  const hasScenes = Number(stats?.scene_count ?? 0) > 0
  const conf = worstConfidence(alerts)
  const sev = hasScenes ? severityOf(conf) : { tier: 'No data', color: 'var(--text-muted)' }

  return (
    <section className="panel detail-panel">
      <div className="detail-head">
        <div className="detail-cover">
          {coverUrl
            ? <img src={coverUrl} alt={`Sentinel-2 true colour, ${waterbody.name}`} />
            : <span className="detail-cover-empty" aria-hidden />}
        </div>
        <div className="detail-head-main">
          <div className="detail-title-row">
            <h2 className="detail-name">{waterbody.name}</h2>
          </div>
          <div className="detail-loc mono">
            <MapPin size={12} weight="duotone" />
            {waterbody.id}
          </div>
          <div className="detail-pills">
            <span className="detail-badge" style={{ color: sev.color, borderColor: sev.color }}>
              {sev.tier}
            </span>
            {hasScenes && (
              <span className="detail-badge is-monitoring" title={`${stats.scene_count} real Sentinel-2 scenes`}>
                Monitoring
              </span>
            )}
          </div>
        </div>
      </div>

      {!hasScenes && (
        <div className="detail-pending">
          Processing — historical data not yet available for this water body.
        </div>
      )}

      {waterbody.description && (
        <p className="detail-desc">{waterbody.description}</p>
      )}

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
                label="Zone"
                value={zoneName ?? '—'}
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

              <RecentAlerts
                alerts={alerts}
                waterbodyId={waterbody.id}
                selectedAlert={selectedAlert}
                onSelectAlert={onSelectAlert}
                onViewAll={() => setTab('Alerts')}
              />
            </>
          )
        )}

        {tab === 'Time Series' && (
          <>
            {/* The tab's primary content is the real chart for the selected
                zone. It used to be a bare list of the 48 acquisition dates —
                real data rendered as an unusable wall of text. */}
            {selectedZoneId ? (
              <TimeSeriesChart
                series={series}
                index={index}
                loading={seriesLoading}
                error={seriesError}
                alert={zoneAlert}
                onIndexChange={onIndexChange}
                height={190}
              />
            ) : (
              <Unavailable
                title="No zone selected"
                reason="Click a zone on the map to plot its real observations."
                source="GET /waterbodies/{id}/timeseries"
              />
            )}

            {/* The date list stays available, demoted to a scrollable table. */}
            {stats?.scene_count ? (
              <details className="date-details">
                <summary className="date-summary mono">
                  {stats.scene_count} real acquisition dates (newest first)
                </summary>
                <div className="scene-date-list">
                  {stats.scene_dates.slice().reverse().map((d) => (
                    <div key={d} className="scene-date mono">{fmtDate(d)}</div>
                  ))}
                </div>
              </details>
            ) : (
              <EmptyState title="No cached time series" detail="Run the precompute for this water body." />
            )}
          </>
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
