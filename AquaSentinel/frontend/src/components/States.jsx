/**
 * Honest loading / empty / unavailable states.
 *
 * These exist so a panel can never be filled with a plausible-looking stand-in.
 * A skeleton says "still loading"; Unavailable says "this has no real source and
 * here is why". Neither ever resolves into invented data.
 */

export function Skeleton({ lines = 3, height = 12, className = '' }) {
  return (
    <div className={`skeleton ${className}`} aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="skeleton-line"
          style={{ height, width: `${100 - (i % 3) * 18}%` }}
        />
      ))}
    </div>
  )
}

export function SkeletonTile() {
  return (
    <div className="ind-tile skeleton-tile" aria-busy="true">
      <div className="skeleton-line" style={{ height: 10, width: '55%' }} />
      <div className="skeleton-line" style={{ height: 22, width: '70%', marginTop: 8 }} />
      <div className="skeleton-line" style={{ height: 9, width: '40%', marginTop: 8 }} />
    </div>
  )
}

/**
 * A panel whose backend source does not exist. `reason` must be the real reason
 * from the API or the pipeline — never a generic shrug.
 */
export function Unavailable({ title, reason, source, compact = false }) {
  return (
    <div className={`unavailable ${compact ? 'compact' : ''}`} role="note">
      <div className="unavailable-title">{title ?? 'Unavailable'}</div>
      {reason && <div className="unavailable-reason">{reason}</div>}
      {source && <div className="unavailable-source">Source: {source}</div>}
    </div>
  )
}

/** An empty-but-real state (e.g. genuinely zero alerts in the window). */
export function EmptyState({ title, detail }) {
  return (
    <div className="empty-state-compact">
      <div className="empty-title">{title}</div>
      {detail && <div className="empty-detail">{detail}</div>}
    </div>
  )
}

/** Inline error with the backend's own message. */
export function ErrorNote({ error }) {
  if (!error) return null
  const msg = error instanceof Error ? error.message : String(error)
  return <div className="error-note">{msg}</div>
}
