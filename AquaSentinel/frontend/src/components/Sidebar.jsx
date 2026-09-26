/**
 * Left sidebar: pure navigation.
 *
 * The monitored-water-body list was REMOVED from here. Selecting a water body is
 * the map search bar's job now, and the resulting state is read from the detail
 * card — duplicating the list in the sidebar put the same control in two places
 * and let the two disagree. What stays is what belongs to navigation: the brand
 * lockup, the routes, the Sentinel-2 promo and the product-boundary statement.
 *
 * The boundary card is permanent by design (design.md §4): "not a lab
 * replacement" is a judging criterion and must be visible on every view, so it
 * is never a tooltip or a dismissable footer.
 */

import {
  ChartLine, Compass, Drop, Graph, Info, MapTrifold, ShieldCheck, Siren, SquaresFour,
} from '@phosphor-icons/react'

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: Graph, enabled: true },
  { id: 'map', label: 'Map', icon: MapTrifold, enabled: true },
  { id: 'alerts', label: 'Alerts', icon: Siren, enabled: true },
  { id: 'lakes', label: 'Lake / Reservoir', icon: Drop, enabled: false },
  { id: 'analytics', label: 'Analytics', icon: ChartLine, enabled: false },
  { id: 'compare', label: 'Compare', icon: SquaresFour, enabled: false },
  { id: 'sources', label: 'Data Sources', icon: Info, enabled: false },
  { id: 'about', label: 'About', icon: Compass, enabled: false },
]

/**
 * Satellite thumbnail for the promo card. It is the real true-colour composite
 * for the currently selected water body's latest scene — the same PNG the map
 * draws, so the card cannot advertise imagery the app is not actually using.
 * Falls back to a gradient tile while no scene has loaded.
 */
function PromoThumb({ imageUrl, alt }) {
  if (!imageUrl) {
    return <div className="promo-thumb promo-thumb-empty" aria-hidden><span className="mono">S2</span></div>
  }
  return (
    <div className="promo-thumb">
      <img src={imageUrl} alt={alt} loading="lazy" />
      <span className="promo-thumb-badge mono">Sentinel-2</span>
    </div>
  )
}

export function Sidebar({ active, onNavigate, alertCount = 0, thumbUrl, thumbAlt }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark"><Drop size={18} weight="fill" /></span>
        <div className="brand-text">
          <div className="brand-name">
            <span className="brand-aqua">Aqua</span><span className="brand-sentinel">Sentinel</span>
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
              className={`nav-item ${active === item.id ? 'is-active' : ''}`}
              onClick={() => item.enabled && onNavigate(item.id)}
              disabled={!item.enabled}
              title={item.enabled ? item.label : `${item.label} — not built in this release`}
            >
              <Icon size={17} weight={active === item.id ? 'fill' : 'regular'} className="nav-icon" />
              <span className="nav-label">{item.label}</span>
              {item.id === 'alerts' && alertCount > 0 && (
                <span className="nav-badge">{alertCount}</span>
              )}
              {!item.enabled && <span className="nav-soon">Soon</span>}
            </button>
          )
        })}
      </nav>

      <div className="sidebar-foot">
        <div className="promo-card">
          <PromoThumb imageUrl={thumbUrl} alt={thumbAlt} />
          <div className="promo-body">
            <div className="promo-title">Sentinel-2</div>
            <div className="promo-sub">Real satellite data</div>
            <ul className="promo-specs">
              <li>10 m resolution</li>
              <li>Multispectral analysis</li>
            </ul>
            <a
              className="promo-link"
              href="https://sentinel.esa.int/web/sentinel/missions/sentinel-2"
              target="_blank"
              rel="noreferrer noopener"
            >
              Learn more <span aria-hidden>&rarr;</span>
            </a>
          </div>
        </div>

        <div className="boundary-card">
          <div className="boundary-head">
            <ShieldCheck size={14} weight="fill" />
            <span>Not a lab replacement</span>
          </div>
          <p>
            AquaSentinel detects visually observable water quality changes from
            satellite imagery. It does not measure pH, heavy metals, <em>E. coli</em>{' '}
            or any lab-based parameters.
          </p>
        </div>
      </div>
    </aside>
  )
}
