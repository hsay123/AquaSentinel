/**
 * Header KPI strip + the GEE status chip.
 *
 * Every figure is read from a real backend field (see UI_DATA_MAP.md §B):
 *   Water Bodies      -> GET /waterbodies/-/summary .waterbody_count
 *   Historical Data   -> max(date) - min(date) over real cached observations
 *   Alerts (30d)      -> real alerts within 30 days of the LATEST REAL SCENE
 *                        date, never Date.now() — this data is historical
 *   Data Coverage     -> distinct usable scenes / expected 5-day revisits
 *
 * The "as of" caption is deliberate: the numbers describe cached historical
 * data as of the most recent real acquisition, not a live feed.
 */

import { Broadcast, Database, Drop, Siren } from '@phosphor-icons/react'
import { fmtDate, fmtPct, humanSpan, daysBetween } from '../lib/format.js'
import { Skeleton } from './States.jsx'

/** Alerts within 30 days of the latest real scene date, not of "now". */
function alertsWithin30Days(alerts, asOf) {
  if (!asOf) return []
  const cutoff = daysBetween(asOf, new Date().toISOString()) // unused; kept explicit below
  void cutoff
  const asOfMs = new Date(`${asOf}T00:00:00Z`).getTime()
  const windowMs = 30 * 86400000
  return (alerts ?? []).filter((a) => {
    const t = new Date(`${String(a.date).slice(0, 10)}T00:00:00Z`).getTime()
    if (Number.isNaN(t)) return false
    return t <= asOfMs && asOfMs - t <= windowMs
  })
}

function Tile({ icon: Icon, label, value, sub, accent }) {
  return (
    <div className="kpi-tile">
      <div className="kpi-label">
        <Icon size={13} weight="duotone" />
        <span>{label}</span>
      </div>
      <div className="kpi-value" style={accent ? { color: accent } : undefined}>{value}</div>
      {sub && <div className="kpi-sub mono">{sub}</div>}
    </div>
  )
}

export function KpiStrip({ summary, alerts, asOf: asOfOverride, loading, error }) {
  if (error) {
    return (
      <div className="kpi-strip">
        <div className="kpi-error">KPI data unavailable: {error.message ?? String(error)}</div>
      </div>
    )
  }
  if (loading || !summary) {
    return (
      <div className="kpi-strip">
        <Skeleton lines={1} height={40} />
      </div>
    )
  }

  const bodies = summary.bodies ?? []
  const withData = bodies.filter((b) => b.scene_count)
  // The alert window is anchored to the water body whose alerts are being
  // counted, not to the global maximum across bodies. Mixing them would put
  // Yamuna's Oct-2023 alerts behind a 2024 date from another AOI and report a
  // misleading zero.
  const asOf = asOfOverride ?? summary.as_of
  const recentAlerts = alertsWithin30Days(alerts, asOf)

  // Historical span: the union of every water body's real observation window.
  const spans = withData.map((b) => b.span_days).filter((d) => Number.isFinite(d))
  const totalSpan = spans.length ? Math.max(...spans) : null

  // Coverage: mean of the per-body computed coverage, or null if unknown.
  const coverageVals = withData
    .map((b) => b.data_coverage)
    .filter((v) => Number.isFinite(v))
  const coverage = coverageVals.length
    ? (coverageVals.reduce((a, c) => a + c, 0) / coverageVals.length) * 100
    : null

  return (
    <div className="kpi-strip">
      <Tile
        icon={Drop}
        label="Water Bodies"
        value={summary.waterbody_count ?? '—'}
        sub={`${summary.bodies_with_data ?? 0} with cached data`}
      />
      <Tile
        icon={Database}
        label="Historical Data"
        value={humanSpan(totalSpan)}
        sub={
          withData[0]?.monitoring_since
            ? `since ${fmtDate(withData[0].monitoring_since)}`
            : 'no cached observations'
        }
      />
      <Tile
        icon={Siren}
        label="Alerts (last 30d)"
        value={recentAlerts.length}
        sub={asOf ? `vs. scene ${fmtDate(asOf)}` : 'no scene date'}
        accent={recentAlerts.length > 0 ? 'var(--color-watch)' : undefined}
      />
      <Tile
        icon={Broadcast}
        label="Data Coverage"
        value={fmtPct(coverage, 0)}
        sub={
          withData[0]
            ? `${withData[0].scene_count} scenes / ${withData[0].expected_revisits} expected`
            : 'unavailable'
        }
      />
      <div className="kpi-asof mono">
        {asOf ? `as of ${fmtDate(asOf)}` : 'as of —'} · latest real Sentinel-2 acquisition
        {summary.as_of_note ? ' · cached historical data, not live' : ''}
      </div>
    </div>
  )
}

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

export function GeeStatus({ health }) {
  if (!health) return <div className="gee-status checking">◌ Checking GEE…</div>
  const ok = health.gee_connected
  const status = health.gee_status || (ok ? 'ok' : 'unknown')
  const label = ok ? GEE_STATUS_LABEL.ok : (GEE_STATUS_LABEL[status] ?? GEE_STATUS_LABEL.unknown)
  const tooltip = [health.gee_message, health.gee_fix && `Fix: ${health.gee_fix}`]
    .filter(Boolean).join('\n')
  return (
    <div
      className={`gee-status ${ok ? 'ok' : 'degraded'}`}
      title={tooltip || undefined}
    >
      {ok ? '●' : '○'} {label}
    </div>
  )
}
