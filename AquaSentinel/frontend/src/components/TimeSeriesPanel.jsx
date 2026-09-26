/**
 * Time Series Analysis — design.md §2.2 chart spec, all real:
 *   - observed line from the cached per-zone observations
 *   - seasonal baseline band = mean ± 2σ, from data/baselines
 *   - gaps preserved: connectNulls={false} so missing scenes show as gaps
 *   - flagged anomaly point marked with its REAL z-score
 *   - the "Anomaly Detected" callout quotes the real z from the Alert object
 */

import {
  Area, CartesianGrid, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Warning } from '@phosphor-icons/react'
import { INDEX_META, fmtDate, fmtNum } from '../lib/format.js'
import { Skeleton, EmptyState, Unavailable, ErrorNote } from './States.jsx'

function buildSeries(points, index) {
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

export function TimeSeriesPanel({ series, index, loading, error, alert, onIndexChange }) {
  const meta = INDEX_META[index]
  const chartData = buildSeries(series, index)
  const hasData = chartData.some((d) => d.value != null)

  // The band is drawn as upper minus lower, stacked on the lower bound.
  const bandData = chartData.map((d) => ({
    ...d,
    band: d.upper != null && d.lower != null ? d.upper - d.lower : null,
  }))

  const flagged = alert
    ? {
        date: String(alert.date).slice(0, 10),
        z: alert.indicators?.find((i) => i.name === index)?.z_score ?? null,
        name: alert.indicators?.find((i) => i.name === index)?.name,
      }
    : null

  return (
    <section className="panel ts-panel">
      <div className="panel-head">
        <div className="panel-title">Time Series Analysis</div>
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
      </div>

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
          <div className="ts-chart">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={bandData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2A3A4A" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#6B7A8D', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                  tickFormatter={(d) => fmtDate(d).slice(3, 8)}
                  axisLine={{ stroke: '#2A3A4A' }}
                  tickLine={{ stroke: '#2A3A4A' }}
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fill: '#6B7A8D', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                  axisLine={false}
                  tickLine={false}
                  width={46}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  contentStyle={{
                    background: '#1A2535',
                    border: '1px solid rgba(56,200,255,0.3)',
                    borderRadius: 8,
                    fontSize: 11,
                  }}
                  labelStyle={{ color: '#9AA4B2', fontFamily: 'JetBrains Mono, monospace' }}
                  formatter={(v, n) => (v == null ? '—' : fmtNum(v, 4))}
                  labelFormatter={(d) => fmtDate(d)}
                />

                {/* Baseline ±2σ band: stacked area from lower bound up to upper. */}
                <Area
                  type="monotone"
                  dataKey="lower"
                  stackId="band"
                  stroke="none"
                  fill="transparent"
                  legendType="none"
                />
                <Area
                  type="monotone"
                  dataKey="band"
                  stackId="band"
                  stroke="none"
                  fill="var(--color-baseline-alpha)"
                  fillOpacity={1}
                  legendType="none"
                />
                <ReferenceLine
                  y={chartData.find((d) => d.baselineMean != null)?.baselineMean ?? 0}
                  stroke="var(--color-baseline)"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                  ifOverflow="extendDomain"
                />

                {/* Observations: gaps are preserved, never interpolated. */}
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#9AA4B2"
                  strokeWidth={1.6}
                  dot={false}
                  connectNulls={false}
                  name={`${meta.short} observed`}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Real anomaly callout — quotes the real z-score from the Alert. */}
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
                {alert.explanation && (
                  <div className="anomaly-explanation">{alert.explanation}</div>
                )}
              </div>
            </div>
          ) : (
            <div className="anomaly-none">
              No anomaly recorded for this zone on the selected date.
            </div>
          )}
        </>
      )}
    </section>
  )
}
