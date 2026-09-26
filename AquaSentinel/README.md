# AquaSentinel

**Satellite-based water quality & contamination early-warning system**

A hackathon prototype built on Sentinel-2 L2A imagery via Google Earth Engine. Forks ingestion/frontend patterns from GeoVisionAI with an entirely new analytics core for water quality monitoring.

## Features

- **Water body detection**: MNDWI + per-scene Otsu thresholding (not fixed threshold)
- **4 spectral indices**: NDTI (turbidity), NDCI (chlorophyll-a), FAI (floating algae), Texture anomaly (surface disturbances)
- **Seasonal baseline**: Rolling mean ± 2σ per zone, per calendar month
- **Anomaly detection**: Z-score (statistical, high confidence) + Isolation Forest (multivariate, needs review)
- **Explainability**: Template-grounded explanations with banned-phrase enforcement
- **Demo-ready**: Precomputed cache for 2 real water bodies with documented events

## Demo Water Bodies (Locked)

| Water Body | Event | Date | Source |
|------------|-------|------|--------|
| Yamuna River, Delhi (Kalindi Kunj) | Toxic foam / surfactant discharge | 2023-09-10, 2024-10-19 | CNN, The Hindu |
| Hussain Sagar Lake, Hyderabad | Cyanobacterial bloom | 2024-04-22 to 2024-04-25 | Times of India, Telangana Today, TSPCB |

See [DEMO_AOIS.md](DEMO_AOIS.md) for full details including GeoJSON polygons, Sentinel-2 tile IDs, and baseline windows.

## Architecture

```
GEE (Sentinel-2 L2A) → ingestion.py → water_mask.py → indices.py
                                                         ↓
                                              timeseries_store.py (Parquet)
                                                         ↓
                                              anomaly.py (z-score + IsolationForest)
                                                         ↓
                                              alerts.py + explain.py
                                                         ↓
                                              FastAPI → React/Leaflet frontend
```

## Quickstart

> **New laptop? Start here → [SETUP.md](SETUP.md).** It has the exact
> copy-pasteable sequence, the service-account request, and a table mapping every
> `GEE Offline` variant to its fix. In short:
> `cp .env.example .env` → get the service account key from the repo owner →
> `pip install -r backend/requirements.txt` → `npm install` → `./setup.sh` →
> run both servers and confirm the header says `● GEE Connected`.

### Prerequisites

- Python 3.11+ (3.12–3.14 verified)
- Node.js 18+
- GEE Cloud project access: `project-326ab593-31e9-43ed-8cd`
- A GEE **service account** key (shared with the team) — see SETUP.md step 5.
  `earthengine authenticate` still works for solo local dev, but it writes to
  your home directory and therefore does not travel to another laptop or CI.

### Backend Setup

```bash
# from the repo root
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r backend/requirements.txt
cp .env.example .env             # then fill in the GEE_* values

uvicorn backend.main:app --reload --port 8000
```

Run uvicorn **from the repo root** — the app is imported as the `backend`
package, and data paths resolve relative to the root. `./start_demo.sh` does all
of the above plus the precompute in one command.

### Frontend Setup

```bash
cd frontend
npm install
npm run dev  # http://localhost:5173
```

Vite proxies `/api/*` → `http://localhost:8000/*` (stripping the prefix), so the
backend must be on port 8000. Override with `VITE_BACKEND_ORIGIN`.

### Verify your install

```bash
./setup.sh        # or .\setup.ps1 on Windows
```

Prints a PASS/FAIL summary covering the venv, dependencies, `.env`, the service
account key and a **live Earth Engine round-trip**, then exits non-zero on
failure — no digging through logs required.

### Precompute Demo Data (Required for Demo)

```bash
python -m backend.scripts.precompute
```

This fetches real Sentinel-2 data for both demo AOIs over their full baseline windows and builds the cached Parquet time series store. **Must be run before demo.**

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (GEE connectivity, cache status, **and the specific GEE failure reason + fix**) |
| GET | `/waterbodies` | List monitored water bodies |
| GET | `/waterbodies/{id}` | Get water body details |
| GET | `/waterbodies/{id}/timeseries` | Time series for zone/index |
| GET | `/alerts` | Alert feed for water body |
| GET | `/alerts/{id}/evidence` | Evidence images |
| POST | `/waterbodies` | Register new water body (admin) |
| POST | `/ingest/run` | Trigger ingestion (demo: reads cache; live: calls GEE) |

## Project Structure

```
AquaSentinel/
├── SETUP.md              # New-laptop setup: exact sequence + GEE failure table
├── setup.sh / setup.ps1  # Automated setup + PASS/FAIL verification
├── DEMO_AOIS.md          # Locked demo AOIs with sources
├── architecture.md        # System architecture
├── design.md              # UI/UX design spec
├── PRD.md                 # Product requirements
├── backend/
│   ├── main.py            # FastAPI app
│   ├── gee_client.py      # GEE initialization
│   ├── cache.py           # Demo water body definitions
│   ├── models/schemas.py  # Pydantic models
│   ├── routers/
│   │   ├── waterbody.py   # Water body endpoints
│   │   └── alerts.py      # Alert endpoints
│   ├── pipeline/
│   │   ├── ingestion.py   # GEE fetch + SCL masking
│   │   ├── water_mask.py  # MNDWI + per-scene Otsu
│   │   ├── indices.py     # NDTI, NDCI, FAI, Texture
│   │   ├── timeseries_store.py  # Parquet store
│   │   ├── anomaly.py     # Z-score + IsolationForest
│   │   ├── alerts.py      # Alert objects + evidence
│   │   └── explain.py     # Template explanations
│   ├── scripts/precompute.py  # Build demo cache
│   └── tests/
│       ├── conftest.py
│       ├── test_indices.py
│       └── test_integration.py
└── frontend/
    ├── src/
    │   ├── main.jsx
    │   ├── App.jsx        # Main app with 4 screens
    │   └── styles/app.css # Design system
    └── package.json
```

## Design Principles (from design.md)

1. **Traceability**: Every number traces to a real satellite scene
2. **Color scale**: Green → Amber → Red consistently everywhere
3. **Small multiples**: Time series charts stacked, not overlaid
4. **Gaps shown**: Missing data = visible gaps, not interpolation
5. **Boundary banner**: Persistent, non-dismissable product disclaimer

## Explainability Rules (enforced in code)

- Always name specific indicator(s) that triggered
- Always state σ deviation or qualitative signal
- Always name zone/sector
- **Never** claim specific contaminant, chemical, or health risk
- Say "consistent with" not "caused by" or "is"

## Testing

```bash
# from the repo root
# Unit tests (no GEE needed)
venv/bin/python -m pytest backend/tests/test_indices.py -v

# Integration tests (require precomputed cache)
venv/bin/python -m pytest backend/tests/test_integration.py -v -m integration
```

## Demo Script (3 minutes)

1. **Open dashboard** → Shows 2 water bodies with status chips
2. **Click Yamuna River** → Map centers on Delhi reach, zone grid colored by severity
3. **Click red zone (zone_2)** → Time series panel opens with 4 small-multiple charts
4. **Observe NDCI/FAI spike** at 2023-09-10 (foam event) with red flagged point outside baseline band
5. **Click alert card** in feed → Opens detail with explanation: *"Surface texture anomaly is 2.8σ above baseline... consistent with foam/surface disturbance"*
6. **Point to persistent banner** at bottom: *"AquaSentinel flags optically observable satellite anomalies to prioritize sites for ground investigation. It does not replace laboratory water testing."*

## Data Honesty (Hard Constraints)

- ❌ No synthetic/dummy/mocked satellite data anywhere
- ✅ All indices computed from real Sentinel-2 L2A via GEE
- ✅ Precomputed cache used for demo; live GEE is secondary path
- ✅ ML-only flags labeled "needs review" — never high confidence
- ✅ Banned-phrase check in explanation generation code

## License

MIT — Hackathon prototype