/**
 * Bottom-row "Time Series Analysis" panel. A thin wrapper that supplies the
 * title/index switcher around the shared TimeSeriesChart so the bottom row and
 * the right-hand "Time Series" tab can never drift apart.
 */

import { TimeSeriesChart } from './TimeSeriesChart.jsx'

export function TimeSeriesPanel({ series, index, loading, error, alert, onIndexChange }) {
  return (
    <section className="panel ts-panel">
      <TimeSeriesChart
        series={series}
        index={index}
        loading={loading}
        error={error}
        alert={alert}
        onIndexChange={onIndexChange}
        title="Time Series Analysis"
        height={200}
      />
    </section>
  )
}
