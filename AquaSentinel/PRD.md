# PRD.md — AquaSentinel: Satellite-Based Water Quality & Contamination Intelligence

Fork of GeoVisionAI's ingestion/frontend skeleton, new analytics core. Built for R2-P6.

## 1. Problem

Regulators and municipal water bodies can't afford to send a boat and a lab kit to every
river, lake, and reservoir every week. Contamination events (algal blooms, sediment
discharge, oil/industrial spills) are often visible from space *before* anyone on the
ground notices — but nobody is watching continuously. We build a system that watches,
flags, and explains, so ground teams know **where to send the boat first.**

We are explicitly **not** building a lab-replacement. We are building a triage layer.

## 2. Users

- **Primary:** State/municipal pollution control board analyst — logs in once a day,
  checks the alert feed, decides which 2–3 flagged sites get a ground inspection.
- **Secondary:** NGO/community water-watch volunteer — monitors a single lake, wants a
  plain-language explanation, not a raw index value.
- **Judge/demo viewer:** needs to see real data, a real historical anomaly, and a
  traceable explanation in under 3 minutes.

## 3. Goals (MVP, hackathon scope)

1. Monitor **2–3 real, named water bodies** with Sentinel-2 L2A imagery over a
   **12–24 month** window (real data — see §9).
2. Detect the water body boundary per scene (MNDWI + per-scene Otsu), handling cloud
   cover and seasonal boundary shift.
3. Compute 4 spectral indicators per scene: turbidity (NDTI), chlorophyll/algae (NDCI),
   floating algae (FAI), and a surface-anomaly texture score.
4. Build a per-zone (grid-cell, not per-pixel, for MVP) seasonal baseline (rolling
   mean + σ) and flag z-score deviations.
5. Fuse indicators (statistical + Isolation Forest) into a single alert with a
   severity score and confidence.
6. Generate a template-grounded, human-readable explanation for every alert — no
   free-floating LLM claims not traceable to a computed number.
7. Serve alerts + before/after evidence + time-series charts on a map dashboard.
8. Display the "not a lab replacement" boundary statement in the UI persistently.

## 4. Non-goals (explicitly out of scope for MVP)

- Per-pixel (10m) time series for the whole AOI history — grid-cell (e.g. 100–300m
  zones) is enough and 10–50x cheaper to compute; per-pixel is a stretch goal.
- Real-time/streaming ingestion — batch, re-run on demand or nightly cron is fine.
- Mobile app, user accounts/auth, multi-tenant orgs.
- Any chemistry inferred beyond what's optically observable (no pH, no heavy metals,
  no E. coli — say so explicitly in the UI).
- Sentinel-3 OLCI integration (documented as a stretch source in the original notes;
  cut for MVP, Sentinel-2 alone is sufficient and simpler to source).

## 5. Functional requirements (mapped to the judging rubric)

| Req from problem statement | MVP requirement | Priority |
|---|---|---|
| Water-Body Detection | MNDWI + per-scene Otsu, SCL cloud mask, boundary polygon per scene | P0 |
| Spectral Analysis | NDTI, NDCI, FAI, texture-anomaly, each with rationale shown in UI | P0 |
| Temporal Monitoring | Per-zone time series, rolling seasonal baseline (mean+σ) | P0 |
| Intelligent Anomaly Detection | z-score per indicator (P0) + Isolation Forest multivariate (P1) | P0/P1 |
| Alert Generation | Structured alert object: id, waterbody, polygon, date, indicator(s), severity, evidence | P0 |
| Explainability | Template-based sentence generated from the actual computed numbers | P0 |
| Product boundary statement | Persistent banner + footer on every alert card | P0 |

## 6. Success metrics for the demo

- At least **one real historical event** (e.g. a documented algal bloom) is
  successfully re-detected by the pipeline on cached historical data, and the judge
  can see the date, the indicator spike, and the generated explanation line up with
  publicly reportable facts about that event.
- Alert generation is deterministic and reproducible on the same cached data (no
  "sometimes it doesn't flag it" flakiness during a live demo).
- Every number shown in the UI traces back to a real Sentinel-2 band value — no
  placeholder or interpolated numbers.

## 7. Risks

| Risk | Mitigation |
|---|---|
| GEE quota/latency during live judging | Precompute + cache full time series for demo AOIs to disk (same pattern as GeoVisionAI's presets) at build time; live GEE call is a bonus path, not the demo path |
| Not enough history for a "seasonal" baseline | Fall back to a rolling all-history mean+σ (not month-matched) if <18 months of clean scenes exist; say so in the UI rather than faking seasonality |
| Cloud cover gaps break the time series | SCL-based masking + linear-interpolate gaps <2 scenes; flag (don't interpolate) gaps >45 days |
| Judges ask "is this real data" | Every alert card shows scene ID, acquisition date/time, and a link/reference to the actual Sentinel-2 tile — data provenance is a first-class UI element, not a footnote |

## 8. Team ownership (from open questions in the original notes)

- Ingestion + water-body detection: 1 owner
- Spectral indices + anomaly fusion: 1 owner
- Alert schema + explainability templates: 1 owner
- Frontend (map, time-series chart, alert feed): 1 owner
- Demo AOI selection, data validation, pitch: shared

## 9. Demo AOI selection (must be locked in week 1)

Do not pick an AOI abstractly — pick it by **searching for a documented, dated,
public-record contamination or bloom event first**, then verify Sentinel-2 has clean
coverage for that date range. Two strong candidate categories:
1. A lake/reservoir with a reported cyanobacteria/algal bloom event in the last 2–3
   years (many state pollution boards and news outlets publish these with dates).
2. A river reach with a reported industrial discharge or major turbidity event
   (construction runoff, dam release, monsoon sediment pulse) with a public date.

Lock 2 AOIs by end of day 1. Everything downstream (baseline length, cache format,
demo script) depends on this.
