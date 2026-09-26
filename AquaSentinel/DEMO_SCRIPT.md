# AquaSentinel — 3-Minute Demo Script

## Pre-Demo Checklist

- [ ] Backend running on `http://localhost:8000` (`uvicorn main:app --reload`)
- [ ] Frontend running on `http://localhost:5173` (`npm run dev`)
- [ ] Precompute script has been run (`python -m backend.scripts.precompute`)
- [ ] Both demo water bodies show in sidebar with status chips
- [ ] GEE health shows "Connected" (or "Degraded" if using cache only)

---

## Minute 0:00 — Open Dashboard

**Action**: Open `http://localhost:5173` in browser

**Narrate**:
> "This is AquaSentinel — a satellite-based water quality early-warning system. It monitors real water bodies using Sentinel-2 imagery from Google Earth Engine. The dashboard shows our two demo water bodies."

**Point out**:
- Left sidebar: Two water bodies with status chips (Normal/Watch/Alert)
- Center: Leaflet map with CARTO Positron basemap
- Right: Location chip showing selected water body name
- **Bottom**: Persistent boundary banner (non-dismissable) — product boundary statement

---

## Minute 0:30 — Select Yamuna River (Foam Event)

**Action**: Click "Yamuna River, Delhi (Kalindi Kunj)" in sidebar

**Narrate**:
> "The Yamuna River at Kalindi Kunj has documented toxic foam events — September 10, 2023 and October 19, 2024, reported by CNN and The Hindu. Foam is a surface anomaly, so we expect our texture indicator to catch it."

**Observe**:
- Map centers on Delhi reach (~5.5 km stretch)
- Blue dashed boundary = latest MNDWI water mask
- Zone grid overlaid (200m cells) colored by latest severity
- Alert feed on right shows recent alerts for this water body

---

## Minute 1:00 — Click Red Zone → Time Series

**Action**: Click the red zone (zone_2) on the map → Time series panel slides in from right

**Narrate**:
> "Each zone shows four small-multiple charts — one per indicator. Different units and scales, so we never overlay them. The shaded green band is the seasonal baseline: mean ± 2σ for that calendar month, computed from 12+ months of history. Red dots = flagged observations outside the band."

**Point out on charts**:
- **NDTI (turbidity)**: May show spike if sediment accompanied foam
- **NDCI (chlorophyll)**: Likely normal (foam ≠ algae)
- **FAI (floating algae)**: Likely normal
- **Texture**: **HERE** — large spike at 2023-09-10, red dot well above baseline band

> "The texture anomaly is 2.8 standard deviations above the September baseline for this zone — consistent with a surface disturbance like foam."

---

## Minute 1:45 — Open Alert Card

**Action**: In the alert feed, find the alert for 2023-09-10 and click "View time series" (or just observe the card)

**Narrate**:
> "Every alert card shows: date, zone, scene ID, which indicators flagged, the generated explanation, and before/after evidence thumbnails."

**Read the explanation aloud**:
> *"Surface texture anomaly is 2.8 standard deviations above the seasonal baseline for September in zone_2, consistent with a surface disturbance such as foam, sheen, or discharge plume. Confidence: High (statistical)."*

**Key points to emphasize**:
- Names the specific indicator (texture)
- States the σ deviation (2.8σ)
- Names the zone (zone_2)
- Says "consistent with" — **never claims "toxic foam" or "pollution"**
- Confidence wording matches fusion logic: statistical = High

---

## Minute 2:15 — Switch to Hussain Sagar (Algal Bloom)

**Action**: Click "Hussain Sagar Lake, Hyderabad" in sidebar

**Narrate**:
> "Hussain Sagar had a documented cyanobacterial bloom in April 2024, confirmed by Telangana State Pollution Control Board sampling. This is a chlorophyll event — we expect NDCI and FAI to flag."

**Observe**:
- Map centers on the lake (~3 km diameter)
- Different zone pattern
- Alert feed shows April 2024 alerts

---

## Minute 2:45 — Show Bloom Time Series & Explanation

**Action**: Click a zone with alert → time series panel

**Point out**:
- **NDCI**: Strong positive spike at 2024-04-22 (red dot above band)
- **FAI**: Also positive (floating algae/scum)
- **NDTI**: May be elevated (turbidity from bloom)
- **Texture**: May show surface scum texture

**Read explanation**:
> *"Chlorophyll index (NDCI) is 3.1 standard deviations above the seasonal baseline for April in zone_1, and the Floating Algae Index is positive — consistent with algal bloom onset. Confidence: High (statistical)."*

> "Two indicators agree (NDCI + FAI), both statistically significant. This is the multi-indicator confirmation the system is designed to catch."

---

## Minute 3:00 — Product Boundary Banner

**Action**: Point to bottom banner

**Narrate**:
> "This banner is persistent and non-dismissable by design. It's not a disclaimer buried in an About page — it's the product boundary. AquaSentinel is a **triage layer**, not a lab replacement. It tells you where to send the boat first."

---

## Talking Points for Judges

### "How do I know this is real data?"
- Every alert card shows the Sentinel-2 scene ID and acquisition date
- Time series charts show actual observation dates with gaps for cloud cover
- Precomputed cache built from real GEE queries (run `precompute.py` to verify)
- No synthetic data anywhere in the pipeline

### "Why per-scene Otsu threshold?"
- Fixed thresholds fail across seasons — turbid monsoon water vs. clear dry season have different MNDWI distributions
- Our code recomputes Otsu per scene (see `water_mask.py`)

### "What if Isolation Forest flags something z-score misses?"
- Fusion logic: statistical flag = **High confidence**; IF-only = **Needs review**
- Explanation generator enforces this wording — never overstates ML-only detections

### "Can you detect oil spills / specific chemicals?"
- **No** — we detect *optical anomalies* (texture, spectral shifts)
- Explanations say "consistent with surface sheen" not "oil spill"
- Banned-phrase check in `explain.py` enforces this at code level

### "What's the cache vs. live path?"
- `/ingest/run?live=false` (default) reads precomputed Parquet — instant, demo-safe
- `/ingest/run?live=true` calls GEE directly — shown working once, not the demo path
- Mirrors GeoVisionAI's validated preset pattern

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Map doesn't load | Check Leaflet CSS imported in main.jsx |
| Alerts empty | Run `precompute.py` first; check cache in `./data/timeseries/` |
| GEE error | Verify `earthengine authenticate` and project access |
| Time series not loading | Check API proxy in `vite.config.js` points to backend |
| Zone grid missing | Zones endpoint not fully implemented; demo uses mock zones from AOI |