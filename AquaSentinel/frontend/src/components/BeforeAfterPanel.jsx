/**
 * Before / After comparison — a permanent grid cell with room to actually read
 * two images, rather than a floating stub over the map.
 *
 * Uses the real evidence pair for the active alert: the true-colour composite
 * for the nearest real prior scene ("before") and for the flagged scene
 * ("after"), both rendered from Earth Engine.
 *
 * The alert feed does not carry imagery inline (rendering ~3 GEE calls per
 * flagged zone would stall the feed), so the pair is fetched on demand via
 * GET /alerts/evidence for the alert in view. Nothing is substituted for a
 * missing image: no stock imagery, no gradient, no fabricated second frame.
 *
 * The empty state is a designed state, not dead space — this cell has no
 * evidence most of the time, because an alert must be selected first.
 */

import { useEffect, useState } from 'react'
import { ArrowsLeftRight, ImageSquare } from '@phosphor-icons/react'
import { getAlertEvidence } from '../api/client.js'
import { fmtDate, fmtNum, severityOf } from '../lib/format.js'
import { ErrorNote } from './States.jsx'

/** One-line auto summary: the strongest indicator, its z, and where it hit. */
function oneLiner(alert) {
  const z = alert?.indicators?.find((i) => i.z_score != null)
  if (!alert) return null
  if (!z) return alert.explanation
  const sign = z.z_score >= 0 ? '+' : ''
  return `${z.name.toUpperCase()} ${sign}${fmtNum(z.z_score, 1)}σ over ${alert.zone_id}, ` +
    `consistent with ${z.name === 'ndci' || z.name === 'fai' ? 'algal bloom onset' : 'turbidity increase'}.`
}

export function BeforeAfterPanel({ alert, waterbodyId }) {
  const [state, setState] = useState({ status: 'idle', data: null, error: null })

  const zoneId = alert?.zone_id ?? null
  const date = alert?.date ? String(alert.date).slice(0, 10) : null
  const key = waterbodyId && zoneId && date ? `${waterbodyId}|${zoneId}|${date}` : null

  useEffect(() => {
    if (!key) { setState({ status: 'idle', data: null, error: null }); return }
    let dead = false
    setState({ status: 'loading', data: null, error: null })
    getAlertEvidence(waterbodyId, zoneId, date)
      .then((d) => { if (!dead) setState({ status: d ? 'ready' : 'unavailable', data: d, error: null }) })
      .catch((e) => { if (!dead) setState({ status: 'unavailable', data: null, error: e }) })
    return () => { dead = true }
  }, [key, waterbodyId, zoneId, date])

  const d = state.data
  const before = d?.before_image_url ?? null
  const after = d?.after_image_url ?? null
  const beforeDate = d?.before_date ?? null
  const afterDate = d?.after_date ?? date
  const renderError = d?.render_error ?? state.error?.message ?? null
  const sev = alert ? severityOf(alert.confidence) : null

  return (
    <section className="panel ba-panel">
      <div className="panel-head">
        <div className="panel-title">
          <ArrowsLeftRight size={14} weight="duotone" />
          <span>Before / After</span>
        </div>
        <div className="panel-sub mono">
          {alert ? `${alert.zone_id} · ${fmtDate(alert.date)}` : 'no alert selected'}
        </div>
      </div>

      {state.status === 'loading' && (
        <div className="ba-empty">
          <ImageSquare size={22} weight="duotone" className="ba-empty-icon" />
          <div className="ba-empty-title">Rendering real evidence…</div>
          <div className="ba-empty-note">
            Two Sentinel-2 true-colour composites for {zoneId} are being fetched from Earth Engine.
          </div>
        </div>
      )}

      {state.status !== 'loading' && (!before || !after) && (
        <div className="ba-empty">
          <ImageSquare size={22} weight="duotone" className="ba-empty-icon" />
          <div className="ba-empty-title">
            {alert ? 'No evidence pair for this alert' : 'Select an alert to compare scenes'}
          </div>
          <div className="ba-empty-note">
            {renderError
              ? renderError
              : alert
                ? 'The renderer produced no comparable prior acquisition for this zone.'
                : 'Pick a flagged zone on the map, or an alert in the detail card, and the two real acquisitions appear here side by side.'}
          </div>
        </div>
      )}

      {before && after && (
        <>
          <div className="ba-pair">
            <figure className="ba-thumb">
              <img src={before} alt={`True colour on ${fmtDate(beforeDate)}`} loading="lazy" />
              <figcaption className="ba-cap mono">
                <span className="ba-cap-tag">Before</span>
                {fmtDate(beforeDate)}
              </figcaption>
            </figure>
            <figure className="ba-thumb">
              <img src={after} alt={`True colour on ${fmtDate(afterDate)}`} loading="lazy" />
              <figcaption className="ba-cap mono">
                <span className="ba-cap-tag">After</span>
                {fmtDate(afterDate)}
              </figcaption>
            </figure>
          </div>

          <div className="ba-note">
            {sev && (
              <span className="ba-sev" style={{ color: sev.color }}>{sev.tier} confidence</span>
            )}
            <span className="ba-line">{oneLiner(alert) ?? alert?.explanation}</span>
            <span className="ba-src mono">
              Real Sentinel-2 true colour (B4/B3/B2), 2nd-percentile stretch · SCL cloud mask
            </span>
          </div>
        </>
      )}

      {state.error && !before && <ErrorNote error={state.error} />}
    </section>
  )
}
