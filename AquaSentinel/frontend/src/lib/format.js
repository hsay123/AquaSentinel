/**
 * Formatting + the single severity taxonomy.
 *
 * SEVERITY is the one place the badge language is defined. The triad is
 * red / amber / blue, applied identically to the sidebar pills, the map status
 * dots, the indicator cards and the alert badges:
 *
 *   confidence 'high'          -> High    -> red   (#ef4444)
 *   confidence 'needs_review'  -> Medium  -> amber (#f59e0b)
 *   confidence 'none'/absent   -> Low     -> blue  (#3b82f6)
 *
 * Low is BLUE, not green. There is no green anywhere in this palette: nothing
 * here measures a lab parameter, so a nominal reading is "nothing to follow up
 * on", never "certified good". Green would over-claim.
 *
 * severity 0-1, from anomaly.py:
 *   high         = min(1, (max|z|/4) * (1 + 0.2 * n_statistical))
 *   needs_review = 0.3 (flat, ML-only)
 *
 * Sidebar dots, map zone shading, alert badges and the water-body status badge
 * ALL call severityOf() so two colour languages can never coexist.
 */

export const CONFIDENCE_TO_TIER = {
  high: { tier: 'High', token: 'var(--sev-high)', color: '#ef4444', rank: 3 },
  needs_review: { tier: 'Medium', token: 'var(--sev-medium)', color: '#f59e0b', rank: 2 },
  none: { tier: 'Low', token: 'var(--sev-low)', color: '#3b82f6', rank: 1 },
}

/**
 * The statistical flag line, mirrored from backend/pipeline/anomaly.py.
 *
 * Z_THRESHOLD there decides "high" confidence; the evidence endpoint uses
 * `>= 2` for the same test. Both are the same number, and it is repeated here
 * (rather than imported from a second definition) so the indicator cards colour
 * themselves with exactly the rule the alerts were raised with.
 */
export const Z_THRESHOLD = 2.0

/** Aggregate a set of alerts into the worst confidence present. */
export function worstConfidence(alerts = []) {
  let worst = 'none'
  for (const a of alerts) {
    if (a?.confidence === 'high') return 'high'
    if (a?.confidence === 'needs_review') worst = 'needs_review'
  }
  return worst
}

export function severityOf(confidence) {
  return CONFIDENCE_TO_TIER[confidence] ?? CONFIDENCE_TO_TIER.none
}

/**
 * z-score against a seasonal baseline — the identical formula to
 * anomaly.compute_z_scores: (value - mean) / std.
 *
 * Returns null whenever it cannot be computed honestly (no value, no baseline,
 * zero spread, non-finite) so callers show an em dash rather than a fake 0.0.
 */
export function zScore(value, mean, std) {
  if (value == null || mean == null || std == null) return null
  if (!Number.isFinite(value) || !Number.isFinite(mean) || !Number.isFinite(std)) return null
  if (std === 0) return null
  return (value - mean) / std
}

/**
 * Severity for a single observation, expressed in the same three-tier language
 * the sidebar pills, the zone shading and the alert badges already use:
 *   |z| >= 2        -> High   (red)    the anomaly.py statistical flag
 *   |z| >= 1        -> Medium (amber)  watch band
 *   otherwise       -> Low    (green)
 *
 * Returns null when there is no z at all: "not measured" must never render as
 * a reassuring green.
 */
export function severityFromZ(z) {
  if (z == null || !Number.isFinite(z)) return null
  const az = Math.abs(z)
  const confidence = az >= Z_THRESHOLD ? 'high' : az >= Z_THRESHOLD / 2 ? 'needs_review' : 'none'
  return severityOf(confidence)
}

/**
 * Sidebar / water-body status.
 *
 * A body with no cached observations gets an explicit "No data yet" state, NOT
 * a green "Low" dot. `worstConfidence([])` returns 'none', which maps to the
 * green Low tier; showing that beside "area unavailable" implies "checked and
 * fine" when the truth is "not analysed yet". Anything without cached scenes is
 * therefore surfaced as a neutral pending state.
 */
export function bodyStatus(stats, confidence) {
  const hasScenes = Number(stats?.scene_count ?? 0) > 0
  if (!hasScenes) {
    return {
      kind: 'no-data',
      label: 'No data yet',
      color: 'var(--text-muted)',
      note: 'Historical data not yet available',
    }
  }
  const sev = severityOf(confidence ?? 'none')
  return {
    kind: 'analysed',
    label: sev.tier,
    color: sev.color,
    note: `${stats.scene_count} real scene${stats.scene_count === 1 ? '' : 's'}`,
  }
}

/** Trend direction, and the colour it should wear.
 *
 * These are CONTAMINATION indicators: a rising value is a worsening signal, so
 * an upward delta is red and a downward one is nominal blue. Never auto-green an
 * upward arrow — that is the single easiest way to make this dashboard lie.
 */
export function deltaTone(changePct) {
  if (changePct == null || !Number.isFinite(changePct)) return { dir: 'flat', color: 'var(--text-muted)' }
  if (changePct > 0.5) return { dir: 'up', color: 'var(--sev-high)' }
  if (changePct < -0.5) return { dir: 'down', color: 'var(--sev-low)' }
  return { dir: 'flat', color: 'var(--text-muted)' }
}

/** The trend rule, applied identically everywhere:
 *  (latest value - seasonal baseline mean) / |baseline mean| * 100
 *  Returns null when it cannot be computed honestly (no baseline, zero mean,
 *  or no observation) so the UI shows an em dash instead of a fake number.
 */
export function trendPct(value, baselineMean) {
  if (value == null || baselineMean == null) return null
  if (!Number.isFinite(value) || !Number.isFinite(baselineMean)) return null
  if (Math.abs(baselineMean) < 1e-9) return null
  return ((value - baselineMean) / Math.abs(baselineMean)) * 100
}

export function fmtNum(v, digits = 3) {
  if (v == null || !Number.isFinite(v)) return '—'
  return Number(v).toFixed(digits)
}

export function fmtPct(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v.toFixed(digits)}%`
}

export function fmtSignedPct(v, digits = 0) {
  if (v == null || !Number.isFinite(v)) return '—'
  const s = v > 0 ? '+' : ''
  return `${s}${v.toFixed(digits)}%`
}

export function fmtArea(km2) {
  if (km2 == null || !Number.isFinite(km2)) return '—'
  return `${km2.toFixed(2)} km²`
}

export function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  })
}

export function fmtMonth(iso) {
  if (!iso) return '—'
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** Days between two ISO dates. */
export function daysBetween(a, b) {
  if (!a || !b) return null
  const da = new Date(`${a}T00:00:00Z`).getTime()
  const db = new Date(`${b}T00:00:00Z`).getTime()
  if (Number.isNaN(da) || Number.isNaN(db)) return null
  return Math.round((db - da) / 86400000)
}

export function humanSpan(days) {
  if (days == null || !Number.isFinite(days)) return '—'
  if (days < 45) return `${days} days`
  const months = Math.round(days / 30.44)
  if (months < 24) return `${months} months`
  return `${(days / 365.25).toFixed(1)} years`
}

/** Index display metadata, matching backend/pipeline/render.py. */
export const INDEX_META = {
  ndti: { label: 'Turbidity (NDTI)', short: 'NDTI', unit: 'reflectance index' },
  ndci: { label: 'Chlorophyll-a (NDCI)', short: 'NDCI', unit: 'reflectance index' },
  fai: { label: 'Floating Algae (FAI)', short: 'FAI', unit: 'reflectance index' },
  texture_score: { label: 'Texture Anomaly', short: 'Texture', unit: 'score' },
}
