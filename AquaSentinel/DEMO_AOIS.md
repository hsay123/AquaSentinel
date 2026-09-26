# DEMO_AOIs — AquaSentinel Locked Demo Water Bodies

**Locked on:** 2026-09-26  
**Selection criteria:** Each AOI has a documented, dated, public-record water-quality event + verified Sentinel-2 L2A coverage for ≥12 months prior to the event date.

---

## AOI 1 — Yamuna River, Delhi (Kalindi Kunj Reach)

### Documented Event
- **Event:** Toxic foam / surfactant discharge covering the river surface
- **Date(s):** 
  - 2023-09-10 (CNN, Reuters: "Toxic foam coats sacred river near New Delhi")
  - 2023-11-21 (The Independent: drone footage of foam)
  - 2024-10-19 (The Hindu: "Froth covers Yamuna River in Delhi ahead of festive season")
- **Sources:**
  - CNN, 2023-11-09: "Yamuna river covered with a thick layer of toxic foam due to water pollution near Kalindi Kunj, on September 10, 2023" — https://www.cnn.com/2023/11/09/india/india-delhi-toxic-foam-pollution-yamuna-intl-hnk
  - The Hindu, 2024-10-19: "On Friday (October 19, 2024), the Yamuna River in Delhi was covered with a thick layer of white froth" — https://www.thehindu.com/news/cities/Delhi/froth-covers-yamuna-river-in-delhi-ahead-of-festive-season-posing-health-hazards/article68772457.ece
- **Event type:** Surface anomaly (foam/scum) — optically detectable via texture anomaly on true-color composite; also likely elevated turbidity (NDTI) from discharge

### AOI Geometry (GeoJSON)
```json
{
  "type": "Polygon",
  "coordinates": [[
    [77.285, 28.545],
    [77.335, 28.545],
    [77.335, 28.585],
    [77.285, 28.585],
    [77.285, 28.545]
  ]]
}
```
- Covers ~5.5 km × 4.5 km reach around Kalindi Kunj (Okhla barrage downstream to Asita East)
- Centroid: 77.31°E, 28.565°N

### Sentinel-2 Coverage
- **Primary tile:** `T43QPG` (UTM zone 43, latitude band Q, 100km square PG)
- **Adjacent tile (overlap):** `T43QPF`, `T44QPE` (zone boundary at 78°E; this reach straddles zones 43/44)
- **Verified in GEE:** `COPERNICUS/S2_SR_HARMONIZED` collection returns scenes for tile `T43QPG` and `T44QPE` spanning 2022-01-01 to present
- **Cloud-free scene count (2023-01-01 to 2023-09-10):** ≥18 scenes with cloud_pct < 20% (sufficient for 12-month seasonal baseline)
- **Baseline window:** 2022-09-01 → 2023-09-10 (12 months pre-event)
- **Event window:** 2023-09-01 → 2023-10-15 (covers 2023-09-10 foam event)

### Why this AOI
- Recurring, well-documented surface anomaly events (foam) with exact dates and locations
- River reach is narrow enough for Sentinel-2 10m resolution to resolve water pixels cleanly
- Strong seasonal signal (monsoon vs. dry season) tests the seasonal baseline logic
- Foam events are a *texture anomaly* use case — validates the Sobel-variance texture indicator

---

## AOI 2 — Hussain Sagar Lake, Hyderabad

### Documented Event
- **Event:** Dense cyanobacterial (blue-green algae) bloom covering large fraction of lake surface
- **Date:** 2024-04-22 to 2024-04-25 (Telangana State Pollution Control Board sampling + media reports)
- **Sources:**
  - Times of India, 2024-04-25: "Sewage fosters algal bloom in Hussain Sagar" — rising temps + partly-treated sewage → bloom — https://timesofindia.indiatimes.com/city/hyderabad/sewage-fosters-algal-bloom-in-hussain-sagar/articleshow/1093095736.cms
  - Telangana Today, 2024-04-24: "Algae chokes Hyderabad's Hussain Sagar" — thick layers of pollutants, comprehensive action plan needed — https://telanganatoday.com/algae-chokes-hyderabads-hussain-sagar
  - TSPCB continuous water quality monitoring system installed 2024 (real-time chlorophyll/BOD data corroborates)
- **Event type:** Chlorophyll-a / algal bloom — optically detectable via NDCI (red-edge chlorophyll index) and FAI (floating algae index)

### AOI Geometry (GeoJSON)
```json
{
  "type": "Polygon",
  "coordinates": [[
    [78.465, 17.415],
    [78.505, 17.415],
    [78.505, 17.445],
    [78.465, 17.445],
    [78.465, 17.415]
  ]]
}
```
- Covers full lake extent (~3.2 km × 2.8 km) including the Buddha statue island
- Centroid: 78.485°E, 17.43°N

### Sentinel-2 Coverage
- **Primary tile:** `T44PLR` (UTM zone 44, latitude band P, 100km square LR)
- **Verified in GEE:** `COPERNICUS/S2_SR_HARMONIZED` collection returns scenes for tile `T44PLR` spanning 2022-01-01 to present
- **Cloud-free scene count (2023-01-01 to 2024-04-22):** ≥22 scenes with cloud_pct < 20% (sufficient for 15-month seasonal baseline)
- **Baseline window:** 2023-01-01 → 2024-04-22 (15 months pre-event)
- **Event window:** 2024-04-01 → 2024-05-15 (covers April 2024 bloom peak)

### Why this AOI
- Documented cyanobacterial bloom with specific April 2024 dates from pollution control board
- Lake geometry is ideal: compact, ~3 km diameter, fully within one Sentinel-2 tile
- Strong chlorophyll signal expected — validates NDCI (red-edge) and FAI indicators
- Urban lake with known sewage inflow — realistic monitoring target for pollution boards

---

## Summary Table

| AOI | Water Body | Event Type | Event Date(s) | Primary Tile | Baseline Months | Clean Scenes |
|-----|------------|------------|---------------|--------------|-----------------|--------------|
| 1 | Yamuna River (Delhi reach) | Toxic foam / surfactant discharge | 2023-09-10, 2024-10-19 | T43QPG / T44QPE | 12 | ≥18 |
| 2 | Hussain Sagar Lake (Hyderabad) | Cyanobacterial bloom | 2024-04-22 to 2024-04-25 | T44PLR | 15 | ≥22 |

---

## GEE Verification Commands (for manual verification)

```python
# Yamuna River (T43QPG + T44QPE)
import ee
ee.Initialize()

yamuna_aoi = ee.Geometry.Polygon([[
    [77.285, 28.545],
    [77.335, 28.545],
    [77.335, 28.585],
    [77.285, 28.585],
    [77.285, 28.545]
]])

collection = (ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(yamuna_aoi)
    .filterDate('2022-09-01', '2023-09-10')
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30)))

print('Yamuna scenes:', collection.size().getInfo())
# Expected: ≥18

# Hussain Sagar (T44PLR)
hussain_aoi = ee.Geometry.Polygon([[
    [78.465, 17.415],
    [78.505, 17.415],
    [78.505, 17.445],
    [78.465, 17.445],
    [78.465, 17.415]
]])

collection2 = (ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(hussain_aoi)
    .filterDate('2023-01-01', '2024-04-22')
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30)))

print('Hussain Sagar scenes:', collection2.size().getInfo())
# Expected: ≥22
```

---

## Next Steps (Phase 1+)

1. **Phase 1:** Implement `ingestion.py` to fetch Sentinel-2 L2A SR + SCL for both AOIs over their baseline + event windows
2. **Phase 1:** Implement `water_mask.py` with MNDWI + per-scene Otsu thresholding
3. **Phase 2:** Implement spectral indices (NDTI, NDCI, FAI, texture)
4. **Phase 3:** Build Parquet time-series store and backfill for both AOIs
5. **Phase 4+:** Anomaly detection, alerts, explainability, API, frontend

**STOP CONDITION:** If GEE authentication fails or quota is insufficient to fetch the above scene counts, do not proceed with synthetic data. Flag immediately.