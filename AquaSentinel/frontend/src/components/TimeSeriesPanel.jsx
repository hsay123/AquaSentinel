/**
 * "Time Series Analysis" — a permanent grid cell, not a tab.
 *
 * The indicator selector is the labelled dropdown the mockup calls for, and it
 * is the same `index` state the map heatmap and the indicator cards use: one
 * active indicator across every panel.
 */

import { CaretDown, ChartLine, WarningCircle } from '@phosphor-icons/react'
import { INDEX_META } from '../lib/format.js'
import { TimeSeriesChart } from './TimeSeriesChart.jsx'

/** Only the three indices the pipeline actually renders. */
const SELECTABLE = ['ndti', 'ndci', 'fai']

export function TimeSeriesPanel({
  series, index, loading, zoneGate = 'ready', zoneError, error, alert, zoneLabel, onIndexChange,
}) {
  // The zone gate is checked BEFORE the chart so an unreachable zone renders a
  // terminal state rather than leaving a skeleton on screen forever — that
  // permanent-skeleton path was the reported bug.
  const blocked = zoneGate === 'error' || zoneGate === 'no-zone'

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
            disabled={blocked}
          >
            {SELECTABLE.map((k) => (
              <option key={k} value={k}>{INDEX_META[k].label}</option>
            ))}
          </select>
          <CaretDown size={11} weight="bold" aria-hidden />
        </label>
      </div>

      {zoneGate === 'error' && (
        <div className="panel-state">
          <WarningCircle size={20} weight="duotone" className="panel-state-icon" />
          <div className="panel-state-title">Zone geometry unavailable</div>
          <div className="panel-state-note">
            {zoneError?.timedOut
              ? 'The zone request timed out, so there is no series to plot.'
              : zoneError?.message ?? 'No cached zone geometry for this water body.'}
          </div>
          <div className="panel-state-src mono">GET /waterbodies/&#123;id&#125;/zones</div>
        </div>
      )}

      {zoneGate === 'no-zone' && (
        <div className="panel-state">
          <ChartLine size={20} weight="duotone" className="panel-state-icon" />
          <div className="panel-state-title">No zone selected</div>
          <div className="panel-state-note">
            The series is per zone. Select a zone on the map, or search for a water
            body that has a precomputed zone grid.
          </div>
        </div>
      )}

      {!blocked && (
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
      )}
    </section>
  )
}
