"""FastAPI router for waterbody endpoints."""

from __future__ import annotations

from datetime import date
from typing import Optional
from fastapi import APIRouter, HTTPException, Query

from backend.models.schemas import (
    WaterBodyCreate,
    WaterBodyResponse,
    ZoneResponse,
    TimeSeriesPoint,
    TimeSeriesResponse,
)
from backend.cache import get_demo_waterbodies
from backend.pipeline.timeseries_store import TimeseriesStore, BaselineStore
from backend.pipeline.geometry_store import ZoneGeometryStore
from backend.gee_client import check_connectivity
import os
import time
import pandas as pd

router = APIRouter(prefix="/waterbodies", tags=["waterbodies"])

# In-memory registry (demo scope; a real deployment would use a database).
# Seeded from cache.DEMO_WATERBODIES — the locked AOIs in DEMO_AOIS.md. These are
# real monitoring sites, not synthetic stand-ins: the precomputed Parquet
# cache in data/ holds their real Sentinel-2 observations.
WATERBODIES_REGISTRY: dict[str, WaterBodyResponse] = dict(get_demo_waterbodies())

# Data store paths. AQUASENTINEL_DATA_ROOT may be relative; resolve it against
# the repo root so `./data` is found no matter which directory uvicorn was
# started from (running from backend/ used to silently create a second,
# empty data tree there).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_data_root = os.environ.get("AQUASENTINEL_DATA_ROOT", "./data")
DATA_ROOT = _data_root if os.path.isabs(_data_root) else os.path.join(_REPO_ROOT, _data_root)
TS_STORE = TimeseriesStore(DATA_ROOT + "/timeseries")
BASELINE_STORE = BaselineStore(DATA_ROOT + "/baselines")
GEOMETRY_STORE = ZoneGeometryStore(DATA_ROOT + "/geometry")


@router.get("", response_model=list[WaterBodyResponse])
async def list_waterbodies():
    """List all monitored water bodies."""
    return list(WATERBODIES_REGISTRY.values())


@router.get("/{waterbody_id}", response_model=WaterBodyResponse)
async def get_waterbody(waterbody_id: str):
    """Get a specific water body by ID."""
    if waterbody_id not in WATERBODIES_REGISTRY:
        raise HTTPException(status_code=404, detail="Water body not found")
    return WATERBODIES_REGISTRY[waterbody_id]


@router.post("", response_model=WaterBodyResponse)
async def create_waterbody(wb: WaterBodyCreate):
    """Register a new water body (admin/demo control)."""
    import uuid
    wb_id = str(uuid.uuid4())[:8]
    from datetime import datetime
    response = WaterBodyResponse(
        id=wb_id,
        name=wb.name,
        aoi_geojson=wb.aoi_geojson,
        description=wb.description,
        created_at=datetime.utcnow().isoformat(),
    )
    WATERBODIES_REGISTRY[wb_id] = response
    return response


@router.get("/{waterbody_id}/zones", response_model=list[ZoneResponse])
async def get_zones(waterbody_id: str):
    """Get the zone grid geometry for a water body.

    Served from the zone grid persisted by the precompute (data/geometry).
    Previously this returned 501 because the polygons computed during precompute
    were discarded; without them the map had no click targets.
    """
    if waterbody_id not in WATERBODIES_REGISTRY:
        raise HTTPException(status_code=404, detail="Water body not found")

    payload = GEOMETRY_STORE.load(waterbody_id)
    if not payload:
        raise HTTPException(
            status_code=404,
            detail=(
                "No zone geometry cached for this water body. "
                "Run: python -m backend.scripts.precompute"
            ),
        )

    return [
        ZoneResponse(
            id=z["id"],
            waterbody_id=waterbody_id,
            polygon=z["polygon"],
            centroid_lat=z["centroid_lat"],
            centroid_lon=z["centroid_lon"],
            area_m2=z["area_m2"],
        )
        for z in payload["zones"]
    ]


@router.get("/{waterbody_id}/stats")
async def get_waterbody_stats(waterbody_id: str):
    """Real, computed stats for one water body — every field traced to the store.

    Nothing here is defaulted to a plausible number: if a value has no real
    source it comes back as null and the UI is expected to say "unavailable".
    """
    if waterbody_id not in WATERBODIES_REGISTRY:
        raise HTTPException(status_code=404, detail="Water body not found")

    geom = GEOMETRY_STORE.load(waterbody_id)
    zone_ids = TS_STORE.get_all_zones(waterbody_id)
    if not zone_ids:
        raise HTTPException(status_code=404, detail="No cached observations. Run the precompute.")

    frames = [TS_STORE.query(waterbody_id, z) for z in zone_ids]
    frames = [f for f in frames if not f.empty]
    if not frames:
        raise HTTPException(status_code=404, detail="No cached observations. Run the precompute.")

    df = pd.concat(frames, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])
    scene_dates = sorted({d.date().isoformat() for d in df["date"]})
    first, last = df["date"].min(), df["date"].max()

    # Data coverage: distinct usable acquisitions vs the expected Sentinel-2
    # revisit cadence over the same span. Computed, not asserted — a cloudy AOI
    # legitimately lands well below 100%.
    span_days = (last - first).days
    expected_revisits = max(1, round(span_days / 5))
    coverage = min(1.0, len(scene_dates) / expected_revisits)

    return {
        "waterbody_id": waterbody_id,
        "name": WATERBODIES_REGISTRY[waterbody_id].name,
        "monitoring_since": first.date().isoformat(),
        "as_of": last.date().isoformat(),
        "span_days": span_days,
        "scene_count": len(scene_dates),
        "scene_dates": scene_dates,
        "observation_count": int(len(df)),
        "zone_count": len(zone_ids),
        "zones_with_geometry": len(geom["zones"]) if geom else 0,
        "data_coverage": round(coverage, 4),
        "expected_revisits": expected_revisits,
        # Real area of the MNDWI water mask for the reference scene, projected
        # and measured with shapely. null when no geometry is cached.
        "water_area_km2": round(geom["water_area_m2"] / 1e6, 4) if geom else None,
        "water_area_source": "MNDWI water mask, UTM-projected shapely area" if geom else None,
        "otsu_threshold": geom["otsu_threshold"] if geom else None,
        "water_fraction": geom["water_fraction"] if geom else None,
        "reference_scene_id": geom["reference_scene_id"] if geom else None,
        # Bathymetry is not produced anywhere in this pipeline. Reported as
        # unavailable on purpose so no UI invents a depth figure.
        "mean_depth_m": None,
        "mean_depth_note": "Not available: this pipeline measures surface reflectance only.",
        # Latest real value per index across the whole body, for KPI tiles.
        "latest_values": {
            idx: (None if pd.isna(df.sort_values("date")[idx].iloc[-1])
                  else float(df.sort_values("date")[idx].iloc[-1]))
            for idx in ("ndti", "ndci", "fai", "texture_score")
        },
        "texture_score_note": (
            "Not available: texture_score is not computed by the current pipeline."
        ),
    }


#: Summary is derived from ~467 Parquet partitions, so cache it briefly to keep
#: the header KPI strip responsive without lying about freshness.
_SUMMARY_CACHE: dict[str, tuple[float, dict]] = {}
_SUMMARY_TTL_S = 60.0


@router.get("/-/summary")
async def get_summary():
    """KPI-strip data. Every number traces to the store or the zone geometry."""
    now = time.monotonic()
    cached = _SUMMARY_CACHE.get("all")
    if cached and (now - cached[0]) < _SUMMARY_TTL_S:
        return cached[1]

    bodies = []
    for wb_id in WATERBODIES_REGISTRY:
        try:
            bodies.append(await get_waterbody_stats(wb_id))
        except HTTPException:
            bodies.append({
                "waterbody_id": wb_id,
                "name": WATERBODIES_REGISTRY[wb_id].name,
                "has_data": False,
            })

    with_data = [b for b in bodies if b.get("scene_count")]
    as_of = max((b["as_of"] for b in with_data), default=None)

    payload = {
        "waterbody_count": len(WATERBODIES_REGISTRY),
        "waterbody_count_source": "COUNT of registered water bodies (backend/cache.py DEMO_WATERBODIES)",
        "bodies_with_data": len(with_data),
        "as_of": as_of,
        "as_of_note": "Most recent real Sentinel-2 acquisition in the cache. This is historical cached data, not live.",
        "bodies": bodies,
    }
    _SUMMARY_CACHE["all"] = (now, payload)
    return payload


@router.get("/{waterbody_id}/timeseries", response_model=TimeSeriesResponse)
async def get_timeseries(
    waterbody_id: str,
    zone_id: str = Query(...),
    index: str = Query(...),
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
):
    """Get time series data for a zone/index with baseline bands."""
    if waterbody_id not in WATERBODIES_REGISTRY:
        raise HTTPException(status_code=404, detail="Water body not found")

    df = TS_STORE.query(waterbody_id, zone_id, start_date, end_date)
    if df.empty:
        raise HTTPException(status_code=404, detail="No time series data found")

    # Load baselines
    baseline_df = BASELINE_STORE.load(waterbody_id)

    points = []
    for _, row in df.iterrows():
        # Get baseline for this index/month
        month = row["date"].month
        baseline = None
        if not baseline_df.empty:
            b = baseline_df[
                (baseline_df["zone_id"] == zone_id) &
                (baseline_df["index_name"] == index) &
                (baseline_df["month"] == month)
            ]
            if not b.empty:
                baseline = b.iloc[0]

        baseline_mean = float(baseline["mean"]) if baseline is not None else None
        baseline_std = float(baseline["std"]) if baseline is not None else None

        point = TimeSeriesPoint(
            date=row["date"].date() if hasattr(row["date"], "date") else row["date"],
            scene_id=row["scene_id"],
            ndti=row.get("ndti"),
            ndci=row.get("ndci"),
            fai=row.get("fai"),
            texture_score=row.get("texture_score"),
            cloud_pct=row["cloud_pct"],
            baseline_mean=baseline_mean,
            baseline_std=baseline_std,
            baseline_upper=baseline_mean + 2 * baseline_std if baseline_mean and baseline_std else None,
            baseline_lower=baseline_mean - 2 * baseline_std if baseline_mean and baseline_std else None,
            is_flagged=False,  # Would be set by anomaly detection
            z_score=None,
        )
        points.append(point)

    # Check if provisional (< 18 months history)
    date_range = df["date"].max() - df["date"].min()
    provisional = date_range.days < 540  # ~18 months

    return TimeSeriesResponse(
        waterbody_id=waterbody_id,
        zone_id=zone_id,
        index=index,
        points=points,
        provisional=provisional,
        n_scenes=len(df),
    )