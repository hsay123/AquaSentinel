"""Pydantic schemas for API requests and responses."""

from __future__ import annotations

from datetime import date
from typing import Optional, List
from pydantic import BaseModel, Field, ConfigDict


# =============================================================================
# Request/Response models for API endpoints
# =============================================================================

class WaterBodyBase(BaseModel):
    name: str
    aoi_geojson: dict
    description: Optional[str] = None


class WaterBodyCreate(WaterBodyBase):
    pass


class WaterBodyResponse(WaterBodyBase):
    id: str
    created_at: str

    model_config = ConfigDict(from_attributes=True)


class ZoneResponse(BaseModel):
    id: str
    waterbody_id: str
    polygon: dict
    centroid_lat: float
    centroid_lon: float
    area_m2: float

    model_config = ConfigDict(from_attributes=True)


class TimeSeriesPoint(BaseModel):
    date: date
    scene_id: str
    ndti: Optional[float] = None
    ndci: Optional[float] = None
    fai: Optional[float] = None
    texture_score: Optional[float] = None
    cloud_pct: float
    # Baseline band
    baseline_mean: Optional[float] = None
    baseline_std: Optional[float] = None
    baseline_upper: Optional[float] = None
    baseline_lower: Optional[float] = None
    # Flag
    is_flagged: bool = False
    z_score: Optional[float] = None


class TimeSeriesResponse(BaseModel):
    waterbody_id: str
    zone_id: str
    index: str
    points: List[TimeSeriesPoint]
    provisional: bool = False  # True if < 18 months history
    n_scenes: int


class IndicatorDetail(BaseModel):
    name: str
    value: float
    baseline_mean: Optional[float] = None
    baseline_std: Optional[float] = None
    z_score: Optional[float] = None


class AlertEvidence(BaseModel):
    before_scene_id: Optional[str] = None
    after_scene_id: str
    index_map_png_path: str
    chart_png_path: str


class AlertResponse(BaseModel):
    id: str
    waterbody_id: str
    zone_id: str
    zone_polygon: dict
    date: date
    scene_id: str
    indicators: List[IndicatorDetail]
    severity: float
    confidence: str  # "high" | "needs_review"
    explanation: str
    evidence: AlertEvidence
    generated: bool = True  # True if LLM polish was applied


class AlertFeedResponse(BaseModel):
    alerts: List[AlertResponse]
    waterbody_id: str
    since: Optional[date] = None
    count: int


class IngestRunRequest(BaseModel):
    waterbody_id: str
    start_date: date
    end_date: date
    live: bool = False  # If true, call GEE; if false, use cached data


class IngestRunResponse(BaseModel):
    status: str  # "started" | "completed" | "failed"
    waterbody_id: str
    scenes_processed: int
    zones_processed: int
    alerts_generated: int
    message: str
    cached: bool = False


class HealthResponse(BaseModel):
    status: str  # "ok" | "degraded"
    gee_connected: bool
    cache_available: bool


# =============================================================================
# Internal pipeline models (for inter-module communication)
# =============================================================================

class SceneData(BaseModel):
    """Data for a single scene after ingestion."""
    scene_id: str
    date: date
    cloud_pct: float
    image: object  # ee.Image - not serializable, used internally


class ZoneObservation(BaseModel):
    """Per-zone observation for a single scene/date."""
    waterbody_id: str
    zone_id: str
    date: date
    scene_id: str
    ndti: Optional[float] = None
    ndci: Optional[float] = None
    fai: Optional[float] = None
    texture_score: Optional[float] = None
    cloud_pct: float