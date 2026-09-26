/**
 * Water Quality Indicators — four cards, one per index, for the active zone.
 *
 * Each card shows a real value, a real trend and a real status:
 *
 *   value    the index on the latest real observation of the selected zone
 *   delta    % change from the PREVIOUS real observation (not from the mean —
 *            a baseline delta is a level, this is movement)
 *   spark    the whole real series for that index, so the shape is visible
 *   z        the active alert's own z_score when it has one, else
 *            (value - baseline_mean) / baseline_std — anomaly.py's formula
 *   status   severityFromZ(z), the same red/amber/blue taxonomy as the sidebar
 *            pills and the alert badges (see lib/format.js)
 *
 * Arrow semantics are contamination-first: a rising value wears RED because up
 * is worse for turbidity, chlorophyll and algae alike. Nothing here is
 * auto-greened.
 *
 * texture_score is NOT produced by the current pipeline (precompute writes
 * None), so that card stays an explicit unavailable state rather than a
 * plausible number, and is not selectable — there is no series to plot.
 *
 * The header's zone selector drives the same `activeZoneId` state as the map,
 * so the cards always describe the zone the map is highlighting.
 */

import { CaretDown, TrendDown, TrendUp } from '@phosphor-icons/react'
import {
  INDEX_META, deltaTone, fmtNum, fmtSignedPct, severityFromZ, zScore,
} from '../lib/format.js'
import { zoneName } from '../lib/zones.js'
import { SkeletonTile, Unavailable } from './States.jsx'
import { Sparkline } from './Sparkline.jsx'

const CARDS = [
  { key: 'ndti', index: 'ndti' },
  { key: 'ndci', index: 'ndci' },
  { key: 'fai', index: 'fai' },
  { key: 'texture_score', index: 'texture_score', unavailable: true },
]

function zFor(key, point, alert) {
  const fromAlert = alert?.indicators?.find((i) => i.name === key)?.z_score
  if (fromAlert != null) return fromAlert
  if (!point) return null
  return zScore(point[key], point.baseline_mean, point.baseline_std)
}

/** % change against the previous real observation. */
function changePct(points, key) {
  const vals = (points ?? []).filter((p) => p && Number.isFinite(p[key])).map((p) => p[key])
  if (vals.length < 2) return null
  const prev = vals[vals.length - 2]
  if (Math.abs(prev) < 1e-9) return null
  return ((vals[vals.length - 1] - prev) / Math.abs(prev)) * 100
}

function Card({ meta, point, points, error, loading, isActive, onSelect, alert }) {
  if (loading) return <SkeletonTile />

  if (meta.unavailable) {
    return (
      <div className="ind-card ind-unavailable" aria-disabled="true">
        <div className="ind-name">Texture Anomaly</div>
        <div className="ind-value-row">
          <span className="ind-value">—</span>
          <span className="ind-status" style={{ color: 'var(--text-muted)' }}>No data</span>
        </div>
        <Unavailable
          compact
          title="Not computed"
          reason="texture_score is not produced by the current pipeline."
          source="precompute.py writes None"
        />
      </div>
    )
  }

  const value = point?.[meta.key] ?? null
  const z = zFor(meta.key, point, alert)
  const sev = severityFromZ(z)
  const delta = changePct(points, meta.key)
  const tone = deltaTone(delta)
  const arrow = tone.dir === 'up' ? <TrendUp size={12} weight="bold" />
    : tone.dir === 'down' ? <TrendDown size={12} weight="bold" /> : null

  // Sparkline wears the card's own severity colour, so a series heading toward
  // an anomaly is red without needing a legend.
  const sparkColor = sev?.color ?? 'var(--text-muted)'

  return (
    <button
      type="button"
      className={`ind-card ${isActive ? 'is-active' : ''}`}
      style={sev ? { '--ind-color': sev.color } : undefined}
      onClick={() => onSelect(meta.key)}
      aria-pressed={isActive}
      title={`Plot ${INDEX_META[meta.key].label} in the time series`}
    >
      <div className="ind-name">{INDEX_META[meta.key].label}</div>

      <div className="ind-value-row">
        <span className="ind-value">{value == null ? '—' : fmtNum(value, 3)}</span>
        {sev && <span className="ind-status" style={{ color: sev.color }}>{sev.tier}</span>}
      </div>

      <Sparkline
        points={points}
        index={meta.index}
        color={sparkColor}
        flagged={sev?.tier === 'High'}
      />

      <div className="ind-foot">
        {error ? (
          <span className="ind-nodata">series unavailable</span>
        ) : delta == null ? (
          <span className="ind-nodata">not enough history</span>
        ) : (
          /* Up is red: these are contamination indicators. */
          <span className="ind-delta" style={{ color: tone.color }}>
            {arrow}
            {fmtSignedPct(delta, 0)} vs prev.
          </span>
        )}
        {z != null && (
          <span className="ind-z mono">
            {z >= 0 ? '+' : ''}{fmtNum(z, 2)}σ
          </span>
        )}
      </div>
    </button>
  )
}

export function IndicatorTiles({
  latestByIndex, pointsByIndex, errors, loading,
  activeIndex, onSelectIndex, alert, zoneId, zoneLabels, onZoneChange,
}) {
  return (
    <section className="panel indicators-panel">
      <div className="panel-head">
        <div className="panel-title">
          <span className="panel-title-text">Water Quality Indicators</span>
          <label className="head-select">
            <span className="sr-only">Zone</span>
            <select
              value={zoneId ?? ''}
              onChange={(e) => onZoneChange(e.target.value)}
              aria-label="Zone context for the indicator cards"
            >
              {!zoneId && <option value="">No zone selected</option>}
              {zoneId && <option value={zoneId}>{zoneName(zoneId, zoneLabels)}</option>}
            </select>
            <CaretDown size={11} weight="bold" aria-hidden />
          </label>
        </div>
      </div>

      <div className="ind-grid">
        {CARDS.map((c) => (
          <Card
            key={c.key}
            meta={c}
            point={latestByIndex?.[c.key] ?? null}
            points={pointsByIndex?.[c.key] ?? null}
            error={errors?.[c.key]}
            loading={loading}
            alert={alert}
            isActive={activeIndex === c.key}
            onSelect={onSelectIndex}
          />
        ))}
      </div>
    </section>
  )
}
