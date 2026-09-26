# design.md — AquaSentinel UI/UX

## 1. Design principle

Every number on screen must be traceable to a real satellite scene. The UI's job is
to make that traceability obvious, not to hide it behind a polished score. Judges
should be able to click any alert and immediately see the raw index values, the
baseline it's compared against, and the scene date — this is the "explainability"
requirement made visual, not just textual.

## 2. Screens

### 2.1 Dashboard (default view)
- **Left panel:** list of monitored water bodies (2–3 for MVP), each with a status
  chip: `Normal` (green) / `Watch` (amber, 1 indicator flagged) / `Alert` (red, 2+
  indicators agree or severity above threshold).
- **Center:** Leaflet map. Selected water body's boundary polygon (from the latest
  scene's MNDWI mask) drawn in blue. Zone grid overlaid, each cell shaded by its
  latest severity (green→amber→red), matching the status chip logic exactly so
  color language is consistent across the whole app.
- **Right panel:** alert feed for the selected water body, newest first, alert cards
  (see 2.3).
- **Persistent footer banner** (cannot be dismissed, always visible): *"AquaSentinel
  flags optically observable satellite anomalies to prioritize sites for ground
  investigation. It does not replace laboratory water testing."* — this is the
  product-boundary requirement; it is a design element, not a disclaimer buried in
  an About page.

### 2.2 Zone detail / time-series view (click a zone on the map)
- Line chart, x-axis = date, y-axis = index value, one small multiple per
  indicator (NDTI, NDCI, FAI, texture) stacked vertically, not overlaid — different
  units/scales, overlaying them would misrepresent the data.
- Shaded band = seasonal baseline (mean ± 2σ) for that month, computed per zone.
- Points outside the band rendered as filled red dots; points inside as small grey
  dots. This is the single most important chart in the product — it's the visual
  proof that the "anomaly" is a real deviation, not a cherry-picked threshold.
- A visible gap in the line (not interpolated across) for any period with no
  clean-enough scene (cloud cover) — never silently smooth over missing data.

### 2.3 Alert card
```
┌──────────────────────────────────────────────────┐
│ ● ALERT  ·  Zone NE-14  ·  2024-08-03  ·  Sentinel-2 tile T44QLE │
│                                                    │
│ NDCI +2.8σ  ·  FAI positive  ·  2 of 4 indicators agree │
│                                                    │
│ "Chlorophyll index (NDCI) is 2.8 standard deviations   │
│  above the seasonal baseline for August in this zone,  │
│  and the Floating Algae Index is positive — consistent │
│  with algal bloom onset."                            │
│                                                    │
│ [Before]  [After]   (index heatmap thumbnails, click to enlarge) │
│ Confidence: High (statistical)                     │
│                                                    │
│ [View full time series →]                          │
└──────────────────────────────────────────────────┘
```
- "Confidence: High (statistical)" vs "Confidence: Needs review (pattern)" — the
  wording difference matters and must match the anomaly.py fusion logic exactly
  (statistical flags = high confidence, ML-only flags = needs review), so the UI
  never overstates certainty on a novel-pattern-only detection.
- Before/after thumbnails are the actual rendered index heatmap for that zone on
  the flagged date vs. the prior clean baseline date — not a generic icon.

### 2.4 Water body onboarding (admin/demo control, low-fidelity is fine)
- Simple form: name, AOI polygon (paste GeoJSON or draw on map), date range.
  This screen mainly exists to prove the system generalizes beyond the 2 hardcoded
  demo AOIs — doesn't need polish, needs to visibly work once in the demo.

## 3. Visual language

- Color scale: green (#2E7D32) → amber (#F9A825) → red (#C62828), used consistently
  for zone shading, status chips, and alert severity — one scale, everywhere.
- Map base layer: light/minimal (e.g. CARTO Positron) so the water-body polygon and
  zone shading are the visually dominant elements, not the basemap.
- Typography/layout: reuse GeoVisionAI's existing frontend shell/styling rather than
  designing a new system from scratch — hackathon time is better spent on pipeline
  correctness than a new design system.

## 4. Explainability text rules (ties directly to explain.py)

1. Always name the specific indicator(s) that triggered.
2. Always state the σ deviation or the qualitative signal (e.g. "FAI positive"),
   never just "anomaly detected."
3. Always name the zone/sector, never "somewhere in the lake."
4. Never claim a specific contaminant or health risk ("likely industrial discharge",
   "toxic bloom") — say what was optically observed and what it is *consistent
   with*, per the product boundary. This is a wording rule the whole team should
   enforce in code review, since a single overconfident sentence undermines the
   explicit non-goal in the PRD.

## 5. Empty/degraded states (must be designed, not left to break)

- Zone with <18 months of history: baseline band shown as "provisional (n=X
  scenes)" rather than a confident-looking shaded band.
- Cloud-heavy period: chart shows the gap, alert feed shows "no clean scene
  available for zone X in the last N days" rather than silence.
- GEE/live pipeline unavailable during demo: falls back to cached data
  transparently, with a small "cached demo dataset" tag on the alert card —
  honesty about data provenance beats a seamless-looking failure mode.
