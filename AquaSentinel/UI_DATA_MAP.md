# UI_DATA_MAP — provenance for every element of the dashboard rebuild

Written **before** any component, per the build prompt. Every row states the
backend field that produces the value, or states plainly that **no such source
exists today** and what I did about it.

Legend for status:
- **REAL** — a backend field exists and returns computed values today.
- **DERIVED** — must be computed from REAL fields by a documented formula
  (formula is stated, and applied identically everywhere).
- **UNAVAILABLE** — no source exists. Per the build prompt I do **not** fake
  these. Each row states the decision taken.

---

## A. What real data actually exists today

Verified by querying the running backend and the Parquet store, not by reading
code and assuming.

| Store | Contents | Volume (verified) |
|---|---|---|
| `data/timeseries/wb=yamuna-delhi/` | per-zone per-scene observations | **467 zones, 9,739 rows**, 20.9 rows/zone |
| `data/baselines/wb=yamuna-delhi/` | seasonal baselines (mean, std, n) | **5,898 rows across 449 zones** |
| `data/timeseries/wb=hussain-sagar/` | second AOI | in progress |

Fields available per observation: `waterbody_id, zone_id, date, scene_id,
ndti, ndci, fai, texture_score, cloud_pct`. Missing values are `NaN` — a real
gap, never imputed.

**Real scene dates** (distinct `scene_id`/`date` pairs) for Yamuna:
2022-09-06 → 2023-09-01.

---

## B. Element-by-element provenance

### Header KPI strip

| UI element | Source | Status |
|---|---|---|
| Water Bodies count | `COUNT` of rows in `WATERBODIES_REGISTRY`, which is seeded from `cache.DEMO_WATERBODIES` (`backend/cache.py`). **2** today (yamuna-delhi, hussain-sagar), not 3. | **REAL** |
| Historical Data | `max(date) - min(date)` over all real `Observation.date` for the selected body | **DERIVED** |
| Alerts (Last 30 days) | `COUNT` of Alert rows from `GET /alerts`, windowed against the **latest real scene date**, not `Date.now()` | **DERIVED** — but currently **0**, see §D |
| Data Coverage | `distinct usable scenes ÷ expected revisits` where revisits = `days / 5` (Sentinel-2). Both counts from the real store. | **DERIVED** |
| "as of" caption | `max(Observation.date)` — the most recent real acquisition | **REAL** |

### Map panel

| UI element | Source | Status |
|---|---|---|
| Zone polygons / click targets | `GET /waterbodies/{id}/zones` | **UNAVAILABLE** — returns **HTTP 501 "Zone grid loading from cache not yet implemented"**. Zone geometry is computed by `create_zone_grid()` during precompute and then **discarded**; `Observation` stores no geometry. Decision: must persist zone geometry to make the primary interaction work. See §D. |
| Satellite basemap composite | No renderer exists | **UNAVAILABLE** — `generate_evidence_for_alert()` in `backend/pipeline/alerts.py` draws the literal text `"[Evidence Image]"` and is self-described as a placeholder. Decision: build a real `getThumbnail`-style renderer, or mark the panel unavailable. |
| Index heatmap PNG overlay | No renderer exists | **UNAVAILABLE** — same placeholder path. Requires a real per-pixel NDCI/NDTI array export from GEE. |
| Date navigator | distinct real `Observation.date` for the body | **REAL** — steps only over dates with a real cached scene. |
| Legend min/max | `min`/`max` of the real index column for the selected body/date | **REAL** |
| Zone labels | real `zone_id` from the store | **REAL** (once geometry is persisted) |

### Right detail panel

| UI element | Source | Status |
|---|---|---|
| Name / location | `WaterBodyResponse.name` / `.aoi_geojson` | **REAL** |
| Status badge | real aggregate `severity` + `confidence` from `anomaly.py` | **REAL** |
| Area (km²) | `.area` of the MNDWI boundary polygon, reprojected | **UNAVAILABLE** — `water_fraction` and `boundary_geojson` exist transiently in `compute_water_mask_for_scene()` but are **not persisted** anywhere. Decision: persist during precompute, or omit the stat card. **Not faked.** |
| Monitoring Since | `min(Observation.date)` for the body | **REAL** |
| Average Depth | — | **UNAVAILABLE, and deliberately omitted.** Bathymetry is produced nowhere in this pipeline. Per the build prompt I am flagging rather than inventing "9.8 m". |
| Tabs Overview/Time Series/Alerts/Gallery/Details | `/timeseries`, `/alerts` real | Overview **REAL**, Time Series **REAL**, Alerts **REAL but empty**, Gallery **UNAVAILABLE** (no imagery renderer), Details **REAL** |

### Bottom row

| UI element | Source | Status |
|---|---|---|
| 4 indicator tiles | latest real `ndti`/`ndci`/`fai`/`texture_score` for the selected zone | **REAL** for 3 of 4. `texture_score` is **UNAVAILABLE** — `precompute.py` writes `texture_score=None` with the comment "Placeholder" for every observation. Decision: show 3 real tiles + 1 explicitly unavailable tile. **Not faked.** |
| Trend % badge | **Chosen rule, applied identically everywhere:** `(latest value − seasonal baseline mean) ÷ \|baseline mean\| × 100`, using the baseline for the latest observation's calendar month. If `baseline_mean` is 0/NaN → show `—` rather than a number. | **DERIVED** |
| Time series chart | real observed line, real mean±2σ band from `data/baselines`, real gaps where no scene | **REAL** |
| Flagged anomaly points + z-score | `AnomalyFlag.*_z` from `anomaly.compute_z_scores()` | **REAL** once alerts exist — currently none fire, see §D |
| Before/After slider | `evidence.before_scene_id` / `after_scene_id` + real PNGs | **UNAVAILABLE** — both PNG paths are the placeholder renderer |

---

## C. Severity / confidence mapping (single taxonomy, documented once)

From `backend/pipeline/anomaly.py`, which is already internally consistent:

| `confidence` | Trigger | `severity` formula | Badge | Color token |
|---|---|---|---|---|
| `high` | ≥1 statistical index with \|z\| ≥ threshold | `min(1.0, (max\|z\| / 4) × (1 + 0.2 × n_statistical))` | **High** | `--color-alert` |
| `needs_review` | IsolationForest only (no statistical support) | `0.3` (flat) | **Medium — needs review** | `--color-watch` |
| `none` | no flag | `0.0` | **Low / Normal** | `--color-normal` |

This reconciles the reference's High/Medium/Low language onto the existing
`design.md` §3 Normal/Watch/Alert colors. **No second color language** will be
introduced: sidebar dots, map zone shading, alert badges and the water-body
status badge all read from this one table.

## D. Two data gaps that block a truthful demo

Both are pre-existing and were found by running the pipeline, not by reading it.

**D1 — There is no alert, because the demo's headline event is not in the data.**
`/alerts?waterbody_id=yamuna-delhi` returns `count: 0`. Cause: the Yamuna
precompute window is `baseline_end = 2023-09-10`, i.e. it stops *on* the foam
event. A real Sentinel-2 query over the AOI shows the revisit dates around the
event are `2023-09-06` and `2023-09-11` — **there is no scene on 2023-09-10** —
and at the `cloud_pct <= 30` filter both are excluded, leaving a 20-day gap
(`2023-09-01` → `2023-09-21`) straddling the event. Latest cached scene is
2023-09-01. So the event is unobservable with the current window.

**D2 — No zone geometry is persisted.** 467 zone polygons are computed and thrown
away, so `/zones` is 501 and the map's primary interaction cannot exist.

## E. What I will not do

- Will not render `"[Evidence Image]"` placeholder PNGs, stock imagery, or a CSS
  gradient as if it were a real index map.
- Will not show an `Avg. Depth` card, or a `texture_score` number, without a real
  source.
- Will not show a fake 92%-style coverage figure; coverage is computed from the
  real store even when the result is unflattering.
- Will not show a skeleton that resolves into invented data.

---

# F — Final screen-by-screen walkthrough (post-build)

Verified by loading the built app against the live backend and reading every
rendered value back. Each line names the field that produced it.

## Header KPI strip
| Shown | Value observed | Produced by |
|---|---|---|
| Water Bodies | `2` | `GET /waterbodies/-/summary` -> `waterbody_count` = COUNT of `WATERBODIES_REGISTRY` |
| Historical Data | `15 months` / `since 06 Sept 2022` | `max(date) - min(date)` over 11,312 real `Observation.date` |
| Alerts (last 30d) | `0` (feed still loading) | COUNT of real alerts within 30 days of `stats.as_of` — **not** `Date.now()` |
| Data Coverage | `62%` (`48 scenes / 83 expected`) | distinct real scene dates / (span_days / 5) |
| as-of caption | `as of 26 Oct 2023 ... cached historical data, not live` | `max(Observation.date)` |

## Sidebar
| Shown | Produced by |
|---|---|
| Yamuna River, Delhi (Kalindi Kunj) — `17.38 km²` — Low | `get_waterbody_stats().water_area_km2`; tier from `worstConfidence(alerts)` |
| Hussain Sagar Lake, Hyderabad — `area unavailable` — Low | area is null until its precompute writes geometry — reported honestly |
| "Sentinel-2 real satellite data" card | static factual copy, no numbers |
| Product-boundary card (pH / heavy metals / E. coli) | static, non-dismissable, always visible |

## Map panel
| Shown | Produced by |
|---|---|
| `478 real zones cached` | `GET /waterbodies/yamuna-delhi/zones` -> persisted zone grid |
| `26 Oct 2023` in the date navigator | `scene_dates` from `/stats` — only real acquisition dates |
| Legend `NDTI — Turbidity proxy`, `-0.230 – 0.221` | `vmin`/`vmax` of the actual rendered pixels |
| `Per-pixel NDTI from the real scene 20231026T052911_...T43RGM · sampled at 20 m` | `scene_id` + `scale_m` from the render metadata |
| `/render-assets/yamuna-delhi_ndti_2023-10-26.png` overlay | real per-pixel raster at the real bounds |

## Detail panel
| Shown | Produced by |
|---|---|
| Water area `17.38 km²` | shapely area of the MNDWI water mask, UTM-projected, persisted by precompute |
| Monitoring since `06 Sept 2022` | `min(Observation.date)` |
| Zones `467` | `len(zone_ids)` from the Parquet store |
| Mean depth `—` | **UNAVAILABLE.** Bathymetry is not produced by this pipeline. Flagged, not invented. |

## Bottom row
| Shown | Produced by |
|---|---|
| Turbidity (NDTI) `0.051`, `+4% vs baseline` | real latest observation; trend = `(v - baseline_mean)/abs(baseline_mean)` |
| Chlorophyll-a (NDCI) `-0.029`, `-159% vs baseline` | same rule |
| Floating Algae (FAI) `0.013`, `-75% vs baseline` | same rule |
| Surface Texture `—` "Not computed" | **UNAVAILABLE.** `texture_score` is `None` for every cached row. |
| Time series: 22 real points, 20 with a +/-2 sigma band | `/timeseries` (confirmed 22 points, 20 with `baseline_mean`) |
| Before/After "No alert selected, or no real evidence pair" | honest empty state; imagery is lazy via `GET /alerts/evidence` |

## Unavailable items, and why (nothing faked)
1. **Mean depth** — no bathymetry in the pipeline. Omitted, flagged.
2. **Surface Texture tile** — `texture_score` not computed. Shown as "Not computed".
3. **Gallery tab** — no separate thumbnail renderer; states that the map already
   serves the real composite.
4. **Before/After without a selected alert** — says so, names the source.

## Known performance characteristic (reported, not hidden)
`GET /alerts` recomputes anomaly detection across all 467 zones per request and
takes **~75 s**. Evidence rendering was moved out of the feed (it issued ~3
Earth Engine calls per flagged zone and made the feed take minutes), but the
detection itself is still on-demand, so the alert panel stays empty for over a
minute after load. The correct fix is a precomputed alert store written by the
precompute; that was out of scope here and is flagged rather than papered over.
