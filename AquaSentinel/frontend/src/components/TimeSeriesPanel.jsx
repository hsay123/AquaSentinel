/**
 * "Time Series Analysis" panel — a permanent grid cell, not a tab.
 *
 * The indicator selector is a labelled dropdown (the wireframe's
 * "Chlorophyll (NDCI)" control) rather than a row of abbreviations, and it is
 * the same `index` state the map overlay and the indicator cards use: one
 * active indicator across every panel.
 *
 * The chart itself is the shared TimeSeriesChart, so this panel and the
 * right-hand "Time Series" tab can never drift apart.
 */

import { TimeSeriesChart } from './TimeSeriesChart.jsx'
import { INDEX_META } from '../lib/format.js'

/** Only the three indices the pipeline actually renders. */
const SELECTABLE = ['ndti', 'ndci', 'fai']

export function TimeSeriesPanel({
  series, index, loading, error, alert, zoneLabel, onIndexChange,
}) {
  return (
    <section className="panel ts-panel">
      <div className="panel-head">
        <div className="panel-title">Time Series Analysis</div>
        <label className="index-select">
          <span className="sr-only">Indicator</span>
          <select
            value={index}
            onChange={(e) => onIndexChange(e.target.value)}
            aria-label="Indicator to plot"
          >
            {SELECTABLE.map((k) => (
              <option key={k} value={k}>{INDEX_META[k].label}</option>
            ))}
          </select>
        </label>
      </div>

      <TimeSeriesChart
        series={series}
        index={index}
        loading={loading}
        error={error}
        alert={alert}
        onIndexChange={onIndexChange}
        fill
        zoneLabel={zoneLabel}
      />
    </section>
  )
}
