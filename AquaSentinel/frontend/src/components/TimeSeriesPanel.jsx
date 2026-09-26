/**
 * "Time Series Analysis" — a permanent grid cell, not a tab.
 *
 * The indicator selector is the labelled dropdown the mockup calls for, and it
 * is the same `index` state the map heatmap and the indicator cards use: one
 * active indicator across every panel.
 */

import { CaretDown } from '@phosphor-icons/react'
import { INDEX_META } from '../lib/format.js'
import { TimeSeriesChart } from './TimeSeriesChart.jsx'

/** Only the three indices the pipeline actually renders. */
const SELECTABLE = ['ndti', 'ndci', 'fai']

export function TimeSeriesPanel({
  series, index, loading, error, alert, zoneLabel, onIndexChange,
}) {
  return (
    <section className="panel ts-panel">
      <div className="panel-head">
        <div className="panel-title">
          <span className="panel-title-text">Time Series Analysis</span>
        </div>
        <label className="head-select">
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
          <CaretDown size={11} weight="bold" aria-hidden />
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
