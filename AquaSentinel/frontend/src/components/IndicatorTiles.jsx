/**
 * Water Quality Indicators — four cards, one per index, for the active water
 * body and zone.
 *
 * Each card shows a real value and a real status. Nothing here invents a number:
 *
 *   value  the index value on the latest real observation of the selected zone
 *   z      the active alert's own z_score for this index when it has one;
 *          otherwise (value - baseline_mean) / baseline_std from this index's
 *          own seasonal baseline, using anomaly.py's formula. The app therefore
 *          loads one time series per rendered index, so every card is scored
 *          against its own baseline rather than a neighbour's.
 *   status severityFromZ(z) — the same red/amber/green taxonomy as the sidebar
 *          pills and the alert badges (see lib/format.js).
 *
 * texture_score is NOT produced by the current pipeline (precompute writes
 * None), so that card renders as explicitly unavailable rather than a plausible
 * number. See UI_DATA_MAP.md §B.
 *
 * Clicking a card promotes that index to the active one, which drives the map
 * overlay, the time-series panel and (next response) this card's own baseline
 * band — so the four panels can never disagree about which indicator is being
 * read.
 */

import { TrendDown, TrendUp } from '@phosphor-icons/react'
import {
  INDEX_META, fmtNum, fmtSignedPct, severityFromZ, trendPct, zScore,
} from '../lib/format.js'
import { colorAt, colorStops } from '../lib/colormaps.js'
import { SkeletonTile, Unavailable } from './States.jsx'

const CARDS = [
  { key: 'ndti', index: 'ndti' },
  { key: 'ndci', index: 'ndci' },
  { key: 'fai', index: 'fai' },
  { key: 'texture_score', index: 'texture_score', unavailable: true },
]

/**
 * z-score for one index. The alert's real detection output wins when present;
 * the seasonal baseline is only consulted for the index the series was
 * requested for. Returns null rather than a placeholder when neither exists.
 */
function zFor(key, point, alert) {
  const fromAlert = alert?.indicators?.find((i) => i.name === key)?.z_score
  if (fromAlert != null) return fromAlert
  if (!point) return null
  return zScore(point[key], point.baseline_mean, point.baseline_std)
}

function Card({ meta, point, error, loading, isActive, onSelect, alert }) {
  if (loading) return <SkeletonTile />

  if (meta.unavailable) {
    // Deliberately not a button: the pipeline never wrote a series for this
    // index, so selecting it could only ever produce an empty chart.
    return (
      <div className="ind-card ind-unavailable" aria-disabled="true">
        <div className="ind-head">
          <span className="ind-name">{INDEX_META[meta.key].label}</span>
          <span className="ind-pill" style={{ color: 'var(--text-muted)' }}>No data</span>
        </div>
        <div className="ind-value">—</div>
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
  const trend = trendPct(value, point?.baseline_mean ?? null)
  const Up = (trend ?? 0) >= 0

  // The colourbar mirrors the map legend's low/high logic, spanning this
  // card's own seasonal band (mean ± 2σ, the range the chart shades).
  const band = point
    && point.baseline_lower != null && point.baseline_upper != null && value != null
    ? point
    : null
  const pos = band && band.baseline_upper !== band.baseline_lower
    ? (value - band.baseline_lower) / (band.baseline_upper - band.baseline_lower)
    : null
  const stops = colorStops(meta.index)

  return (
    <button
      type="button"
      className={`ind-card ${isActive ? 'is-active' : ''}`}
      style={sev ? { '--ind-color': sev.color } : undefined}
      onClick={() => onSelect(meta.key)}
      aria-pressed={isActive}
      title={`Show ${INDEX_META[meta.key].label} in the time series`}
    >
      <div className="ind-head">
        <span className="ind-name">{INDEX_META[meta.key].label}</span>
        <span className="ind-pill" style={{ color: sev?.color ?? 'var(--text-muted)' }}>
          {sev ? sev.tier : 'No data'}
        </span>
      </div>

      <div className="ind-value">
        <span
          className="ind-swatch"
          aria-hidden
          style={{ background: colorAt(meta.index, pos ?? 0.5) ?? 'var(--bg-elevated)' }}
        />
        {value == null ? '—' : fmtNum(value, 3)}
      </div>

      <div className="ind-foot">
        {error ? (
          <span className="ind-nodata">series unavailable</span>
        ) : value == null ? (
          <span className="ind-nodata">no valid pixels on this date</span>
        ) : z != null ? (
          <span className="ind-z mono">
            {z >= 0 ? '+' : ''}{fmtNum(z, 2)}σ
            {trend != null && (
              <span className={`ind-trend ${Up ? 'up' : 'down'}`}>
                {Up ? <TrendUp size={11} weight="bold" /> : <TrendDown size={11} weight="bold" />}
                {fmtSignedPct(trend)}
              </span>
            )}
          </span>
        ) : (
          <span className="ind-nodata">no seasonal baseline</span>
        )}
      </div>

      <div className="ind-scale">
        {band ? (
          <>
            <div className="ind-scale-bar" style={{ background: `linear-gradient(to right, ${stops})` }}>
              <span
                className="ind-scale-mark"
                style={{ left: `${Math.min(100, Math.max(0, pos * 100))}%` }}
              />
            </div>
            <div className="ind-scale-ends mono">
              <span>low {fmtNum(band.baseline_lower, 2)}</span>
              <span>high {fmtNum(band.baseline_upper, 2)}</span>
            </div>
          </>
        ) : (
          <span className="ind-scale-hint">baseline band ±2σ — select to plot</span>
        )}
      </div>
    </button>
  )
}

export function IndicatorTiles({
  latestByIndex, errors, loading, activeIndex, onSelectIndex, alert,
}) {
  return (
    <section className="panel indicators-panel">
      <div className="panel-head">
        <div className="panel-title">Water Quality Indicators</div>
        <div className="panel-sub mono">latest real observation vs seasonal baseline</div>
      </div>
      <div className="ind-grid">
        {CARDS.map((c) => (
          <Card
            key={c.key}
            meta={c}
            point={latestByIndex?.[c.key] ?? null}
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
