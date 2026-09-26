/**
 * Before / After — a real comparison widget, not two static thumbnails.
 *
 * The pair is the real evidence for the active alert: the true-colour
 * composite for the nearest real prior acquisition ("before") and for the
 * flagged scene ("after"), both rendered from Earth Engine, plus the real index
 * map of the same pair.
 *
 * Drag handling comes from react-compare-slider rather than hand-rolled pointer
 * maths — it already solves resize, touch and keyboard operation, and this
 * panel has no business reimplementing it.
 *
 * The alert feed deliberately carries no imagery (rendering ~3 GEE calls per
 * flagged zone stalled the feed), so the pair is fetched on demand for the alert
 * in view and cached by the backend on disk. Nothing is ever substituted for a
 * missing image: no stock photography, no gradient, no fabricated second frame.
 */

import { useEffect, useMemo, useState } from 'react'
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider'
import { ArrowsLeftRight, ImageSquare } from '@phosphor-icons/react'
import { getEvidence, peekEvidence } from '../lib/evidence.js'
import { fmtDate, fmtNum, severityOf, INDEX_META } from '../lib/format.js'
import { ErrorNote } from './States.jsx'

/**
 * Layers the comparison can show — derived from the evidence payload, never
 * from a fixed list.
 *
 * The renderer produces a before/after TRUE-COLOUR pair, plus ONE index map for
 * the flagged date (the alert's own primary index — backend/pipeline/alerts.py
 * `primary_idx_render`). Offering three index options would be fiction: two of
 * them do not exist. So the index entry appears only when a real index map came
 * back, and its label is read from the returned filename.
 */
function layersFor(data) {
  const out = [{ id: 'truecolor', label: 'True colour' }]
  const url = data?.index_map_url
  if (url) {
    const idx = ['ndti', 'ndci', 'fai'].find((k) => url.includes(`_${k}_`))
    out.push({
      id: 'indexmap',
      label: idx ? `${INDEX_META[idx].label} map` : 'Index map',
    })
  }
  return out
}

/** One-line auto summary: the strongest indicator, its z, and where it hit. */
function oneLiner(alert) {
  if (!alert) return null
  const z = alert.indicators?.find((i) => i.z_score != null)
  if (!z) return alert.explanation
  const sign = z.z_score >= 0 ? '+' : ''
  const what = z.name === 'ndci' || z.name === 'fai'
    ? 'algal bloom onset'
    : 'turbidity increase'
  return `${z.name.toUpperCase()} ${sign}${fmtNum(z.z_score, 1)}σ over ${alert.zone_id}, ` +
    `consistent with ${what}.`
}

export function BeforeAfterPanel({ alert, waterbodyId }) {
  const [state, setState] = useState({ status: 'idle', data: null, error: null })
  const [layer, setLayer] = useState('truecolor')

  const zoneId = alert?.zone_id ?? null
  const date = alert?.date ? String(alert.date).slice(0, 10) : null
  const key = waterbodyId && zoneId && date ? `${waterbodyId}|${zoneId}|${date}` : null

  useEffect(() => {
    if (!key) { setState({ status: 'idle', data: null, error: null }); return }
    // A sibling panel may have already paid for this render.
    const cached = peekEvidence(waterbodyId, zoneId, date)
    if (cached !== undefined) {
      setState({ status: cached ? 'ready' : 'unavailable', data: cached, error: null })
      return undefined
    }
    let dead = false
    setState({ status: 'loading', data: null, error: null })
    getEvidence(waterbodyId, zoneId, date)
      .then((d) => { if (!dead) setState({ status: d ? 'ready' : 'unavailable', data: d, error: null }) })
    return () => { dead = true }
  }, [key, waterbodyId, zoneId, date])

  const d = state.data
  const layers = useMemo(() => layersFor(d), [d])
  // Fall back to true colour if the chosen layer disappears (new alert).
  const activeLayer = layers.some((l) => l.id === layer) ? layer : 'truecolor'

  const pair = useMemo(() => {
    if (!d) return null
    if (activeLayer === 'truecolor') {
      return { before: d.before_image_url, after: d.after_image_url }
    }
    // The index map covers the flagged date only, so it is shown whole rather
    // than pretending it splits into a before/after pair.
    return { before: d.index_map_url, after: d.index_map_url, single: true }
  }, [d, activeLayer])

  const beforeDate = d?.before_date ?? null
  const afterDate = d?.after_date ?? date
  const renderError = d?.render_error ?? state.error?.message ?? null
  const sev = alert ? severityOf(alert.confidence) : null
  const ready = pair?.before && pair?.after

  return (
    <section className="panel ba-panel">
      <div className="panel-head">
        <div className="panel-title">
          <ArrowsLeftRight size={14} weight="duotone" />
          <span className="panel-title-text">Before / After</span>
        </div>
        <label className="head-select">
          <span className="sr-only">Layer</span>
          <select
            value={activeLayer}
            onChange={(e) => setLayer(e.target.value)}
            aria-label="Comparison layer"
          >
            {layers.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          <CaretDownIcon />
        </label>
      </div>

      <div className="ba-sub mono">
        {alert ? `${alert.zone_id} · ${fmtDate(alert.date)}` : 'no alert selected'}
      </div>

      {state.status === 'loading' && (
        <div className="ba-empty">
          <ImageSquare size={22} weight="duotone" className="ba-empty-icon" />
          <div className="ba-empty-title">Rendering real evidence…</div>
          <div className="ba-empty-note">
            Two Sentinel-2 composites for {zoneId} are being fetched from Earth Engine.
          </div>
        </div>
      )}

      {state.status !== 'loading' && !ready && (
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
                : 'Pick a flagged zone on the map, or an alert in the detail card, and drag the divider between the two real acquisitions.'}
          </div>
        </div>
      )}

      {ready && pair.single && (
        <div className="ba-single">
          <img
            src={pair.after}
            alt={`Index map for ${fmtDate(afterDate)}`}
          />
          <span className="ba-single-cap mono">
            {fmtDate(afterDate)} · index map, flagged date only
          </span>
        </div>
      )}

      {ready && !pair.single && (
        <div className="ba-compare">
          <ReactCompareSlider
            itemOne={(
              <ReactCompareSliderImage
                src={pair.before}
                alt={`True colour on ${fmtDate(beforeDate)}`}
                style={{ objectFit: 'cover' }}
              />
            )}
            itemTwo={(
              <ReactCompareSliderImage
                src={pair.after}
                alt={`True colour on ${fmtDate(afterDate)}`}
                style={{ objectFit: 'cover' }}
              />
            )}
            className="ba-slider"
            sliderLineColor="#38bdf8"
            handleColor="#38bdf8"
            hoverHandleColor="#2563eb"
            baseColor="rgba(10,14,20,0.35)"
          />
          <div className="ba-compare-caps mono">
            <span>{fmtDate(beforeDate)} (Before)</span>
            <span>{fmtDate(afterDate)} (After)</span>
          </div>
        </div>
      )}

      {ready && (
        <div className="ba-note">
          {sev && <span className="ba-sev" style={{ color: sev.color }}>{sev.tier} confidence</span>}
          <span className="ba-line">{oneLiner(alert) ?? alert?.explanation}</span>
          <span className="ba-src mono">
            Real Sentinel-2, 2nd-percentile stretch · SCL cloud mask
          </span>
        </div>
      )}

      {state.error && !ready && <ErrorNote error={state.error} />}
    </section>
  )
}

/** Tiny local chevron so the layer select matches the other head-selects. */
function CaretDownIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 256 256" aria-hidden className="head-select-caret">
      <path
        fill="currentColor"
        d="M213.7 101.7l-80 80a8 8 0 0 1-11.4 0l-80-80a8 8 0 0 1 11.4-11.4L128 164.7l74.3-74.4a8 8 0 0 1 11.4 11.4Z"
      />
    </svg>
  )
}
