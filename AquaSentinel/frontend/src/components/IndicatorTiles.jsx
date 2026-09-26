/**
 * Water Quality Indicators — four tiles, three real values and one honest gap.
 *
 * ndti / ndci / fai come from the real per-zone time series. `texture_score` is
 * NOT produced by the current pipeline (precompute writes None for it), so that
 * tile renders as explicitly unavailable rather than a plausible number. See
 * UI_DATA_MAP.md §B.
 *
 * Trend badge rule (identical everywhere, see format.js trendPct):
 *   (latest value - seasonal baseline mean) / |baseline mean| * 100
 */

import { TrendDown, TrendUp } from '@phosphor-icons/react'
import { INDEX_META, fmtNum, fmtSignedPct, trendPct } from '../lib/format.js'
import { SkeletonTile, Unavailable } from './States.jsx'

const TILES = [
  { key: 'ndti', index: 'ndti' },
  { key: 'ndci', index: 'ndci' },
  { key: 'fai', index: 'fai' },
  { key: 'texture_score', index: 'texture_score', unavailable: true },
]

function Tile({ meta, point, loading }) {
  if (loading) return <SkeletonTile />

  if (meta.unavailable) {
    return (
      <div className="ind-tile ind-unavailable">
        <div className="ind-name">{INDEX_META[meta.key].label}</div>
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
  const trend = trendPct(value, point?.baseline_mean ?? null)
  const Up = (trend ?? 0) >= 0

  return (
    <div className="ind-tile">
      <div className="ind-name">{INDEX_META[meta.key].label}</div>
      <div className="ind-value">
        {value == null ? '—' : fmtNum(value, 3)}
      </div>
      <div className="ind-foot">
        {value == null ? (
          <span className="ind-nodata">no valid pixels on this date</span>
        ) : trend == null ? (
          <span className="ind-nodata">no seasonal baseline</span>
        ) : (
          <span className={`ind-trend ${Up ? 'up' : 'down'}`}>
            {Up ? <TrendUp size={12} weight="bold" /> : <TrendDown size={12} weight="bold" />}
            {fmtSignedPct(trend)} vs baseline
          </span>
        )}
      </div>
    </div>
  )
}

export function IndicatorTiles({ latestPoint, loading }) {
  return (
    <section className="panel indicators-panel">
      <div className="panel-head">
        <div className="panel-title">Water Quality Indicators</div>
        <div className="panel-sub mono">latest real observation vs seasonal baseline</div>
      </div>
      <div className="ind-grid">
        {TILES.map((t) => (
          <Tile key={t.key} meta={t} point={latestPoint} loading={loading} />
        ))}
      </div>
    </section>
  )
}
