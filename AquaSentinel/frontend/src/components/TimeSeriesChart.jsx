/**
 * The real time-series chart, shared by the "Time Series Analysis" grid panel
 * and the right-hand "Time Series" tab so the two can never drift apart.
 *
 * All content is real:
 *   - observed line from cached per-zone observations
 *   - seasonal baseline band, shaded, derived client-side as
 *     baseline_mean ± baseline_std (both are returned by the endpoint), i.e. the
 *     honest ±1σ envelope. The endpoint's own baseline_upper/lower are ±2σ and
 *     are used only to draw the wider context line.
 *   - gaps preserved (connectNulls={false}); never interpolated
 *   - the alert's date marked, with its real z-score in a callout
 *
 * The anomaly marker is driven by the `alert` prop rather than the point's
 * is_flagged: the timeseries endpoint hard-codes that field to false because
 * detection is not persisted per point, so marking it from here is the only way
 * the marker reflects something real.
 */

import {
  Area, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Warning } from '@phosphor-icons/react'
import { INDEX_META, fmtDate, fmtNum } from '../lib/format.js'
import { Skeleton, EmptyState } from './States.jsx'

export function buildSeries(points, index) {
  return (points ?? []).map((p) => {
    const value = Number.isFinite(p[index]) ? p[index] : null
    const mean = p.baseline_mean ?? null
    const std = p.baseline_std ?? null
    return {
      date: String(p.date).slice(0, 10),
      value,
      baselineMean: mean,
      std,
      // ±1σ shading: the envelope the mockup calls "seasonal baseline".
      upper1: mean != null && std != null ? mean + std : null,
      lower1: mean != null && std != null ? mean - std : null,
      upper2: p.baseline_upper ?? null,
      lower2: p.baseline_lower ?? null,
      isFlagged: !!p.is_flagged,
      z: p.z_score ?? null,
    }
  })
}

/** "0.4213 (z = +2.8)" — the z row only when the backend actually reported one. */
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

  const chartData = flagged
    ? rawData.map((d) => (d.date === flagged.date
      ? { ...d, isFlagged: true, z: flagged.z ?? d.z }
      : d))
    : rawData
  const hasData = chartData.some((d) => d.value != null)
  const hasBand = chartData.some((d) => d.upper1 != null && d.lower1 != null)
  const meanRef = chartData.find((d) => d.baselineMean != null)?.baselineMean ?? null
  const flaggedPoint = flagged ? chartData.find((d) => d.date === flagged.date) ?? null : null

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
        /* A failed fetch is a state, not a footnote: the raw backend message
           alone left a full-height empty panel with one line of text in it. */
        <div className="chart-error">
          <Warning size={18} weight="duotone" className="chart-error-icon" />
          <div className="chart-error-title">Time series unavailable</div>
          <div className="chart-error-note">{String(error.message || error)}</div>
          <div className="chart-error-src mono">GET /waterbodies/{'{id}'}/timeseries</div>
        </div>
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
            </div>
          )}

          <div className={`ts-chart ${fill ? 'is-fill' : ''}`} style={fill ? undefined : { minHeight: height }}>
            <ResponsiveContainer width="100%" height={fill ? '100%' : height}>
              <LineChart data={chartData} margin={{ top: 10, right: 14, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#6b7a8d', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                  tickFormatter={(d) => fmtDate(d).slice(3, 8)}
                  axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
                  tickLine={{ stroke: 'rgba(255,255,255,0.12)' }}
                  minTickGap={26}
                />
                <YAxis
                  tick={{ fill: '#6b7a8d', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                  axisLine={false}
                  tickLine={false}
                  width={46}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'rgba(59,130,246,0.4)', strokeWidth: 1 }}
                />

                {/* ±1σ seasonal envelope, blue. Drawn as ONE Area with an
                    explicit `base` array: the stacked form renders no <g> in
                    this recharts version, so the band silently disappears. */}
                {hasBand && (
                  <Area
                    type="monotone"
                    dataKey="upper1"
                    base={chartData.map((d) => d.lower1)}
                    stroke="#3b82f6"
                    strokeWidth={1}
                    strokeOpacity={0.5}
                    fill="#3b82f6"
                    fillOpacity={0.18}
                    isAnimationActive={false}
                    legendType="none"
                  />
                )}
                {meanRef != null && (
                  <ReferenceLine
                    y={meanRef}
                    stroke="#60a5fa"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                    ifOverflow="extendDomain"
                  />
                )}

                {/* The anomaly: a real point, a real z, and a callout that
                    points at it instead of a footnote below the chart. */}
                {flaggedPoint && flaggedPoint.value != null && (
                  <ReferenceLine
                    x={flaggedPoint.date}
                    stroke="#ef4444"
                    strokeDasharray="3 3"
                    strokeOpacity={0.7}
                    label={{
                      value: `Anomaly · ${fmtNum(flaggedPoint.value, 2)}${
                        flagged.z != null ? ` (z = ${flagged.z >= 0 ? '+' : ''}${fmtNum(flagged.z, 1)})` : ''}`,
                      position: 'insideTopRight',
                      fill: '#ef4444',
                      fontSize: 10,
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  />
                )}

                {/* connectNulls={false} -> real gaps, never interpolated */}
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#22c55e"
                  strokeWidth={1.8}
                  dot={(p) => (p.payload?.isFlagged ? (
                    <circle
                      key={p.dataKey}
                      cx={p.cx}
                      cy={p.cy}
                      r={4.5}
                      fill="#ef4444"
                      stroke="#fff"
                      strokeWidth={1.5}
                    />
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
            <span><i className="sw-line" /> Observed</span>
            <span><i className="sw-band" /> Seasonal baseline (±1σ)</span>
            <span><i className="sw-flag" /> Anomaly</span>
            <span className="ts-n">{chartData.length} dates · {chartData.filter((d) => d.value != null).length} with data</span>
          </div>

          {flagged ? (
            <div className="anomaly-callout">
              <Warning size={14} weight="fill" />
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
            <div className="anomaly-none">No anomaly recorded for this zone.</div>
          )}
        </>
      )}
    </>
  )
}
