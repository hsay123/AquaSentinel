/**
 * Before / After comparison slider.
 *
 * Uses the real evidence pair attached to the actual Alert: the true-colour
 * composite for the nearest real prior scene ("before") and for the flagged
 * scene ("after"), both rendered from Earth Engine.
 *
 * If the alert carries no evidence (renderer unavailable, or no prior scene),
 * this renders an explicit unavailable panel. It never substitutes stock
 * imagery or a gradient.
 */

import { useState } from 'react'
import { ArrowsLeftRight } from '@phosphor-icons/react'
import { fmtDate } from '../lib/format.js'
import { Unavailable, ErrorNote } from './States.jsx'

const toUrl = (p) => {
  if (!p) return null
  // Evidence is written under data/evidence; expose it the same way as renders.
  const name = String(p).split('/').pop()
  return `/evidence-assets/${name}`
}

export function BeforeAfterSlider({ alert, loading, error }) {
  const [pos, setPos] = useState(50)

  if (error) return <ErrorNote error={error} />

  if (loading) {
    return (
      <section className="panel ba-panel">
        <div className="panel-head"><div className="panel-title">Before / After</div></div>
        <div className="skeleton" style={{ height: 180 }} />
      </section>
    )
  }

  const ev = alert?.evidence ?? {}
  const before = toUrl(ev.before_truecolor_png_path)
  const after = toUrl(ev.after_truecolor_png_path)
  const beforeDate = ev.before_date ?? null
  const afterDate = ev.after_date ?? alert?.date ?? null

  if (!before || !after) {
    return (
      <section className="panel ba-panel">
        <div className="panel-head">
          <div className="panel-title">Before / After</div>
        </div>
        <Unavailable
          title="No alert selected, or no real evidence pair"
          reason={
            alert
              ? (ev.render_error ?? 'The renderer could not produce imagery for this alert.')
              : 'Select a zone with a real alert to compare its two real acquisitions.'
          }
          source="backend/pipeline/render.py → evidence.before/after_date"
        />
      </section>
    )
  }

  return (
    <section className="panel ba-panel">
      <div className="panel-head">
        <div className="panel-title">
          <ArrowsLeftRight size={14} weight="duotone" />
          <span>Before / After</span>
        </div>
        <div className="panel-sub mono">
          {alert.zone_id} · {fmtDate(beforeDate)} → {fmtDate(afterDate)}
        </div>
      </div>

      <div className="ba-stage">
        <img className="ba-img" src={after} alt={`True colour on ${fmtDate(afterDate)}`} />
        <div className="ba-clip" style={{ width: `${pos}%` }}>
          <img className="ba-img" src={before} alt={`True colour on ${fmtDate(beforeDate)}`} />
        </div>
        <div className="ba-divider" style={{ left: `${pos}%` }} />
        <span className="ba-tag ba-tag-left mono">{fmtDate(beforeDate)}</span>
        <span className="ba-tag ba-tag-right mono">{fmtDate(afterDate)}</span>
        <input
          className="ba-range"
          type="range"
          min="0"
          max="100"
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label="Compare before and after"
        />
      </div>
      <div className="ba-note">
        Real Sentinel-2 true-colour composites (B4/B3/B2), 2nd percentile stretch.
        Cloud and shadow pixels masked via the SCL band.
      </div>
    </section>
  )
}
