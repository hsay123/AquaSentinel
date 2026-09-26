/**
 * The real time-series chart (design.md §2.2), shared by the "Time Series
 * Analysis" grid panel and the right-hand "Time Series" tab so both render the
 * same thing instead of one showing a chart and the other a list.
 *
 * All content is real:
 *   - observed line from cached per-zone observations
 *   - seasonal baseline band = mean +/- 2 sigma from data/baselines
 *   - gaps preserved (connectNulls={false}); never interpolated
 *   - flagged anomaly marked, with its real z-score. The timeseries endpoint
 *     hard-codes is_flagged=false, so the marker comes from the real alert for
 *     the plotted zone (passed in as `alert`) — see below.
 */

import {
  Area, CartesianGrid, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Warning } from '@phosphor-icons/react'
import { INDEX_META, fmtDate, fmtNum } from '../lib/format.js'
import { Skeleton, EmptyState, ErrorNote } from './States.jsx'

export function buildSeries(points, index) {
  return (points ?? []).map((p) => ({
    date: String(p.date).slice(0, 10),
    value: Number.isFinite(p[index]) ? p[index] : null,
    baselineMean: p.baseline_mean ?? null,
    upper: p.baseline_upper ?? null,
    lower: p.baseline_lower ?? null,
    isFlagged: !!p.is_flagged,
    z: p.z_score ?? null,
  }))
}

/**
 * Hover readout: value plus the z-score against the seasonal baseline when the
 * backend reported one for that observation, e.g. "0.4213 (z = 2.8)".
 * Invented z-scores are never shown — the row is omitted when there is none.
 */
function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  return (
    <div className="ts-tip">
      <div className="ts-tip-date mono">{fmtDate(d.date)}</div>
      <div className="ts-tip-value mono">
        {d.value == null ? '—' : fmtNum(d.value, 4)}
        {d.z != null && <span className="ts-tip-z"> (z = {d.z >= 0 ? '+' : ''}{fmtNum(d.z, 1)})</span>}
      </div>
      {d.baselineMean != null && (
        <div className="ts-tip-base mono">baseline {fmtNum(d.baselineMean, 4)}</div>
      )}
      {d.isFlagged && <div className="ts-tip-flag">flagged anomaly</div>}
    </div>
  )
}

export function TimeSeriesChart({
  series, index, loading, error, alert, height = 220, onIndexChange, title, fill, zoneLabel,
}) {
  const meta = INDEX_META[index]
  const rawData = buildSeries(series, index)

  const flagged = alert
    ? {
        date: String(alert.date).slice(0, 10),
        z: alert.indicators?.find((i) => i.name === index)?.z_score ?? null,
      }
    : null

  // The timeseries endpoint hard-codes is_flagged=false (detection is not
  // persisted per point), so the marker and its z are taken from the real alert
  // for the plotted zone and attached to the matching date. Nothing is invented:
  // a date with no alert simply has no marker.
  const chartData = flagged
    ? rawData.map((d) => (d.date === flagged.date
      ? { ...d, isFlagged: true, z: flagged.z ?? d.z }
      : d))
    : rawData
  const hasData = chartData.some((d) => d.value != null)

  // Band drawn as a stacked area: lower bound, then (upper - lower).
  const bandData = chartData.map((d) => ({
    ...d,
    band: d.upper != null && d.lower != null ? d.upper - d.lower : null,
  }))
  const meanRef = chartData.find((d) => d.baselineMean != null)?.baselineMean ?? null

  return (
    <>
      {title && (
        <div className="panel-head">
          <div className="panel-title">{title}</div>
          {onIndexChange && (
            <div className="seg">
              {['ndti', 'ndci', 'fai'].map((k) => (
                <button
                  key={k}
                  type="button"
                  className={index === k ? 'is-active' : ''}
                  onClick={() => onIndexChange(k)}
                >
                  {INDEX_META[k].short}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error ? (
        <ErrorNote error={error} />
      ) : loading ? (
        <Skeleton lines={4} height={14} />
      ) : !hasData ? (
        <EmptyState
          title="No real observations for this zone"
          detail="The cached time series has no usable values for this zone and index."
        />
      ) : (
        <>
          {(zoneLabel || meta) && (
            <div className="ts-caption mono">
              {zoneLabel ? `${zoneLabel} · ` : ''}{meta.label}
              {meta.unit ? ` · ${meta.unit}` : ''}
            </div>
          )}
          <div className={`ts-chart ${fill ? 'is-fill' : ''}`} style={fill ? undefined : { minHeight: height }}>
            <ResponsiveContainer width="100%" height={fill ? '100%' : height}>
              <LineChart data={bandData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2A3A4A" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#6B7A8D', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                  tickFormatter={(d) => fmtDate(d).slice(3, 8)}
                  axisLine={{ stroke: '#2A3A4A' }}
                  tickLine={{ stroke: '#2A3A4A' }}
                  minTickGap={26}
                />
                <YAxis
                  tick={{ fill: '#6B7A8D', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  domain={['auto', 'auto']}
                  label={{
                    value: meta.short,
                    angle: -90,
                    position: 'insideLeft',
                    fill: '#6B7A8D',
                    fontSize: 9,
                  }}
                />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'rgba(56,200,255,0.35)', strokeWidth: 1 }}
                />

                {/* Baseline +/-2 sigma band.
                    Drawn as ONE Area with an explicit `base` array rather than
                    two stacked Areas: in this recharts version the stacked form
                    rendered no <g> at all, so the band silently disappeared. */}
                {bandData.some((d) => d.upper != null && d.lower != null) && (
                  <Area
                    type="monotone"
                    dataKey="upper"
                    base={bandData.map((d) => d.lower)}
                    stroke="var(--color-baseline)"
                    strokeWidth={1}
                    strokeOpacity={0.5}
                    fill="var(--color-baseline-alpha)"
                    fillOpacity={1}
                    isAnimationActive={false}
                    legendType="none"
                  />
                )}
                {meanRef != null && (
                  <ReferenceLine
                    y={meanRef}
                    stroke="var(--color-baseline)"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                    ifOverflow="extendDomain"
                  />
                )}

                {/* connectNulls={false} -> real gaps, never interpolated */}
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#C7D2DE"
                  strokeWidth={1.7}
                  dot={(p) => (p.payload?.isFlagged ? (
                    <circle key={p.dataKey} cx={p.cx} cy={p.cy} r={4} fill="var(--color-alert)" stroke="#fff" strokeWidth={1.5} />
                  ) : (
                    <circle key={p.dataKey} cx={p.cx} cy={p.cy} r={0} fill="none" />
                  ))}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                  name={`${meta.short} observed`}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="ts-legend-inline mono">
            <span><i className="sw-line" /> observed</span>
            <span><i className="sw-band" /> baseline ±2σ</span>
            <span><i className="sw-flag" /> flagged</span>
            <span className="ts-n">{chartData.length} dates · {chartData.filter((d) => d.value != null).length} with data</span>
          </div>

          {flagged ? (
            <div className="anomaly-callout">
              <Warning size={14} weight="duotone" />
              <div>
                <div className="anomaly-title">
                  Anomaly detected · {fmtDate(flagged.date)}
                  {flagged.z != null && (
                    <span className="mono"> z = {flagged.z >= 0 ? '+' : ''}{fmtNum(flagged.z, 2)}σ</span>
                  )}
                </div>
                {alert.explanation && <div className="anomaly-explanation">{alert.explanation}</div>}
              </div>
            </div>
          ) : (
            <div className="anomaly-none">No anomaly recorded for this zone on the selected date.</div>
          )}
        </>
      )}
    </>
  )
}
