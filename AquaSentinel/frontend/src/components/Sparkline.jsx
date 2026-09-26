/**
 * Sparkline — the minimal trend strip inside an indicator card.
 *
 * A tiny axis-less line built on the recharts primitives already in the bundle.
 * No axes, no grid, no tooltip: the card's number and delta carry the values,
 * this only has to show the SHAPE of the series, so it must stay quiet.
 *
 * The line wears the card's severity colour (red / amber / blue), so a series
 * heading toward an anomaly reads as red at a glance without a legend.
 */

import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts'

export function Sparkline({ points, index, color, height = 26, flagged }) {
  const data = (points ?? [])
    .filter((p) => p && Number.isFinite(p[index]))
    .map((p) => ({ v: p[index] }))
  if (data.length < 2) {
    return <div className="spark spark-empty" style={{ height }} aria-hidden />
  }

  // Pad the domain slightly so the line never touches the strip's edges.
  const values = data.map((d) => d.v)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1

  return (
    <div className="spark" style={{ height }}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <YAxis hide domain={[lo - pad, hi + pad]} />
          <Line
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.6}
            dot={false}
            isAnimationActive={false}
            {...(flagged
              ? {
                  lastDot: true,
                  renderDot: (p) => (p.index === data.length - 1
                    ? <circle key="last" cx={p.cx} cy={p.cy} r={2.4} fill={color} />
                    : <g key={p.index} />),
                }
              : {})}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
