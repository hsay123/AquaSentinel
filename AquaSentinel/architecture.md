# architecture.md — AquaSentinel

## 1. System overview

```
                         ┌─────────────────────────────────────────┐
                         │            Google Earth Engine            │
                         │      Sentinel-2 L2A (SR + SCL band)       │
                         └───────────────────┬─────────────────────┘
                                              │ ee.ImageCollection
                                              ▼
                    ┌───────────────────────────────────────────────┐
                    │  backend/pipeline/ingestion.py                  │
                    │  - date range fetch per AOI                    │
                    │  - SCL / QA60 cloud+shadow mask                │
                    │  - per-scene reprojection to fixed grid        │
                    └───────────────────┬───────────────────────────┘
                                         ▼
                    ┌───────────────────────────────────────────────┐
                    │  backend/pipeline/water_mask.py                │
                    │  - MNDWI = (Green-SWIR)/(Green+SWIR)            │
                    │  - per-scene Otsu threshold on MNDWI histogram  │
                    │  - boundary polygon extraction (rasterio/shapely)│
                    └───────────────────┬───────────────────────────┘
                                         ▼
                    ┌───────────────────────────────────────────────┐
                    │  backend/pipeline/indices.py                   │
                    │  - NDTI, NDCI, FAI per masked water pixel      │
                    │  - texture/edge anomaly (Sobel var. in RGB)    │
                    │  - aggregate to zone-grid (e.g. 100–300m cells)│
                    └───────────────────┬───────────────────────────┘
                                         ▼
                    ┌───────────────────────────────────────────────┐
                    │  backend/pipeline/timeseries_store.py          │
                    │  - append per-zone, per-date index values      │
                    │  - Parquet/SQLite, keyed (waterbody_id, zone_id,│
                    │    date) — NOT re-fetched every request         │
                    └───────────────────┬───────────────────────────┘
                                         ▼
                    ┌───────────────────────────────────────────────┐
                    │  backend/pipeline/anomaly.py                   │
                    │  - rolling seasonal baseline (mean+σ) per zone │
                    │    per index, month-matched window             │
                    │  - z-score flag (|z| > threshold, e.g. 2.0)    │
                    │  - IsolationForest across [NDTI,NDCI,FAI,tex]  │
                    │    trained on "normal" history per waterbody   │
                    │  - fusion: statistical=high-confidence,        │
                    │    ML-only=needs-review                        │
                    └───────────────────┬───────────────────────────┘
                                         ▼
                    ┌───────────────────────────────────────────────┐
                    │  backend/pipeline/alerts.py                    │
                    │  - build Alert object (schema below)           │
                    │  - backend/pipeline/explain.py: template-fill  │
                    │    sentence from the actual computed numbers   │
                    └───────────────────┬───────────────────────────┘
                                         ▼
                    ┌───────────────────────────────────────────────┐
                    │  backend/routers/waterbody.py, alerts.py       │
                    │  FastAPI REST endpoints (see §4)               │
                    └───────────────────┬───────────────────────────┘
                                         ▼
                    ┌───────────────────────────────────────────────┐
                    │  frontend/ (React + Vite, reused shell)        │
                    │  - Leaflet map: waterbody polygon + zone grid  │
                    │    colored by latest severity                 │
                    │  - Time-series chart per zone (index vs. date, │
                    │    baseline band, flagged points highlighted)  │
                    │  - Alert feed: card per alert, evidence, text  │
                    └─────────────────────────────────────────────────┘
```

## 2. Component responsibilities

- **ingestion.py** — the only module that talks to GEE. All AOI/date-range/cloud
  logic lives here so the rest of the pipeline never touches raw scene handling.
  Reused pattern from GeoVisionAI's ingestion stage.
- **water_mask.py** — isolates water per scene; this replaces GeoVisionAI's
  flood-extent NDWI mask with the MNDWI-based version and per-scene (not fixed)
  thresholding required by the problem statement.
- **indices.py** — pure functions, one per indicator, each returning a per-pixel or
  per-zone array plus the band inputs used (needed for explainability + evidence).
- **timeseries_store.py** — this is the module that does not exist in GeoVisionAI
  and is the architectural core of this project. GeoVisionAI never needed to persist
  more than 2 scenes; this system is meaningless without a real multi-date store.
  Use Parquet files on disk for the hackathon (no DB server needed); schema:
  `(waterbody_id, zone_id, date, ndti, ndci, fai, texture_score, cloud_pct, scene_id)`.
- **anomaly.py** — two independent detectors that must both be inspectable:
  1. Statistical (z-score vs. seasonal baseline) — deterministic, explainable, P0.
  2. IsolationForest — flags multivariate combinations a single index misses, P1.
  Never let the ML layer produce an alert with no supporting statistical signal
  the explain.py template can reference — if IF flags something no single index
  crossed threshold on, label it "novel pattern, needs review" per the problem
  statement's own fusion design, don't force a false single-cause explanation.
- **explain.py** — string templates filled from real computed values only
  (indicator name, σ deviation, sector, direction). No LLM call is required for
  MVP explainability — the problem statement asks for traceability, not prose
  quality. An optional LLM polish pass (Groq, reused from GeoVisionAI's narrative
  module) can rewrite the template sentence more naturally, but only ever *after*
  the deterministic template has been generated, and it must not introduce any
  fact not present in the template. Falls back to the raw template if the LLM
  call fails or is disabled — this mirrors GeoVisionAI's `generated=false` pattern.

## 3. Data model

```
WaterBody { id, name, aoi_geojson, created_at }
Zone      { id, waterbody_id, polygon, centroid_lat, centroid_lon }
Observation { waterbody_id, zone_id, date, scene_id,
              ndti, ndci, fai, texture_score, cloud_pct }
Baseline  { waterbody_id, zone_id, index_name, month,
            mean, std, n_samples }
Alert     { id, waterbody_id, zone_id, polygon, date, scene_id,
            indicators: [{name, value, baseline_mean, baseline_std, z_score}],
            severity: float,          # f(max |z|, num indicators agreeing)
            confidence: "high"|"needs_review",
            explanation: string,      # template output
            evidence: { before_scene_id, after_scene_id,
                        index_map_png_path, chart_png_path }
}
```

## 4. API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/waterbodies` | list monitored AOIs |
| GET | `/waterbodies/{id}/zones` | zone grid geometry |
| GET | `/waterbodies/{id}/timeseries?zone_id=&index=` | time series + baseline band, for the chart |
| GET | `/alerts?waterbody_id=&since=` | alert feed |
| GET | `/alerts/{id}/evidence` | before/after maps + chart image |
| POST | `/ingest/run?waterbody_id=&start=&end=` | (admin/demo) trigger a batch run; in demo mode this reads from the pre-cached Parquet store instead of calling GEE live |

## 5. Reliability / demo-mode design

Mirrors GeoVisionAI's "validated presets" pattern exactly, because it's the right
pattern: **precompute the full time series for both demo AOIs to disk before the
event.** `/ingest/run` in demo mode reads the cached Parquet + cached PNG evidence
instead of hitting GEE live. A live-GEE code path should still exist and be shown
working once, but the actual judged demo must not depend on live network/GEE quota.

## 6. Tech stack

- **Data:** Sentinel-2 L2A via Google Earth Engine Python API (`earthengine-api`)
- **Backend:** FastAPI, rasterio/numpy/shapely for geometry, pandas for time series,
  scikit-learn (IsolationForest), matplotlib (evidence PNGs) — reused from GeoVisionAI
- **Storage:** Parquet (time series) + local filesystem (PNG evidence, GeoJSON) —
  no external DB needed for hackathon scope
- **Frontend:** React + Vite + Leaflet (reused shell), a lightweight chart lib
  (recharts or the hand-rolled SVG pattern GeoVisionAI already used for its
  photo-timeline chart)
- **Optional LLM polish:** Groq (reused client from GeoVisionAI's narrative module)

## 7. What is deliberately reused unchanged from GeoVisionAI

- GEE auth/session setup
- SCL cloud-masking utility
- Disk-cache-for-demo-reliability pattern
- FastAPI app structure, routers folder convention
- Frontend build tooling and Leaflet map shell
- Error-handling philosophy: pipeline failures degrade to null fields, never a
  500 that kills the demo
