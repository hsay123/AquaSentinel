/**
 * Left sidebar: nav, monitored water bodies, and the two persistent footer
 * cards.
 *
 * The product-boundary statement lives here (design.md §4) rather than in a
 * dismissable bottom bar, so it stays visible on every view.
 */

import { Drop, Graph, Info, MapTrifold, ShieldCheck, Siren, Stack, Warning } from '@phosphor-icons/react'
import { bodyStatus, worstConfidence, fmtArea } from '../lib/format.js'

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: Graph, enabled: true },
  { id: 'map', label: 'Map', icon: MapTrifold, enabled: true },
  { id: 'alerts', label: 'Alerts', icon: Siren, enabled: true },
  { id: 'lakes', label: 'Lakes / Reservoirs', icon: Drop, enabled: false },
  { id: 'analytics', label: 'Analytics', icon: Stack, enabled: false },
  { id: 'compare', label: 'Compare', icon: Stack, enabled: false },
  { id: 'sources', label: 'Data Sources', icon: Info, enabled: false },
  { id: 'about', label: 'About', icon: Info, enabled: false },
]

export function Sidebar({
  active, onNavigate, waterbodies, statsById, alertsById, selectedId, onSelect,
}) {
  // Real, already-loaded alert rows only. Never a placeholder number.
  const alertCount = Object.values(alertsById ?? {}).reduce(
    (n, list) => n + (Array.isArray(list) ? list.length : 0),
    0,
  )

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark"><Drop size={18} weight="regular" /></span>
        <div>
          <div className="brand-name">
            <span className="brand-aqua">Aqua</span>
            <span className="brand-sentinel">Sentinel</span>
          </div>
          <div className="brand-sub">Satellite Intelligence for Cleaner Water</div>
        </div>
      </div>

      <nav className="nav">
        {NAV.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${active === item.id ? 'is-active' : ''} ${item.enabled ? '' : 'is-disabled'}`}
              onClick={() => item.enabled && onNavigate(item.id)}
              disabled={!item.enabled}
              title={item.enabled ? item.label : `${item.label} — not built in this release`}
            >
              <Icon size={15} weight="regular" />
              <span>{item.label}</span>
              {/* Count comes from the real loaded alerts for every registered
                  body. Rendered only once at least one body has a loaded alert
                  set, so "not loaded yet" is never shown as a real zero. */}
              {item.id === 'alerts' && alertCount > 0 && (
                <span className="nav-badge">{alertCount}</span>
              )}
              {!item.enabled && <span className="nav-soon">Coming soon</span>}
            </button>
          )
        })}
      </nav>

      <div className="sidebar-section">
        <div className="sidebar-title">Monitored Water Bodies</div>
        <div className="wb-list">
          {waterbodies.length === 0 && (
            <div className="wb-empty">No water bodies registered.</div>
          )}
          {waterbodies.map((wb) => {
            const stats = statsById?.[wb.id]
            const conf = worstConfidence(alertsById?.[wb.id] ?? [])
            const st = bodyStatus(stats, conf)
            return (
              <button
                key={wb.id}
                type="button"
                className={`wb-row ${selectedId === wb.id ? 'is-active' : ''} ${st.kind === 'no-data' ? 'is-pending' : ''}`}
                onClick={() => onSelect(wb.id)}
                title={st.note}
              >
                <span className="wb-dot" style={{ background: st.color }} aria-hidden />
                <span className="wb-text">
                  <span className="wb-name">{wb.name}</span>
                  <span className="wb-meta mono">
                    {st.kind === 'no-data'
                      ? st.note
                      : stats?.water_area_km2 != null
                        ? fmtArea(stats.water_area_km2)
                        : 'area unavailable'}
                  </span>
                </span>
                <span className="wb-tier" style={{ color: st.color }}>{st.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="sidebar-foot">
        <div className="info-card">
          <div className="info-card-head">
            <Drop size={13} weight="regular" />
            <span>Sentinel-2</span>
          </div>
          <div className="info-card-sub">Real satellite data</div>
          <ul className="info-specs">
            <li>10 m resolution</li>
            <li>Multispectral analysis</li>
          </ul>
          <a
            className="info-link"
            href="https://sentinel.esa.int/web/sentinel/missions/sentinel-2"
            target="_blank"
            rel="noreferrer noopener"
          >
            Learn more <span aria-hidden>&rarr;</span>
          </a>
        </div>

        <div className="boundary-card">
          <div className="boundary-head">
            <ShieldCheck size={13} weight="regular" />
            <span>Not a lab replacement</span>
          </div>
          <p>
            Not a lab replacement. AquaSentinel surfaces optically observable
            satellite anomalies to prioritise sites for ground investigation. It
            does not measure pH, heavy metals, <em>E. coli</em>, or any other
            lab-based parameter.
          </p>
        </div>
      </div>
    </aside>
  )
}
