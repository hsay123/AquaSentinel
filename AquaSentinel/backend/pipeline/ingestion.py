"""AOI / date-range ingestion: fetch Sentinel-2 L2A scenes with SCL cloud masking."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

import ee

from backend.pipeline.masking import mask_scl, cloud_pct

S2_COLLECTION = "COPERNICUS/S2_SR_HARMONIZED"
# Bands we need: B2, B3, B4, B5, B8, B11, B12 (10m + 20m), SCL
# B2=Blue, B3=Green, B4=Red, B5=RedEdge1, B8=NIR, B11=SWIR1, B12=SWIR2
S2_BANDS = ["B2", "B3", "B4", "B5", "B8", "B11", "B12", "SCL"]


class NoImageryError(RuntimeError):
    """Raised when a date range has no usable Sentinel-2 scenes."""


def fetch_scenes(
    geometry: ee.Geometry,
    start_date: date,
    end_date: date,
    max_cloud_pct: float = 30.0,
) -> list[ee.Image]:
    """Fetch all Sentinel-2 L2A scenes for an AOI and date range.

    Applies SCL-based cloud/shadow/cirrus mask to each scene.
    Returns a list of masked ee.Images with the required bands.
    """
    collection = (
        ee.ImageCollection(S2_COLLECTION)
        .filterBounds(geometry)
        .filterDate(start_date.isoformat(), end_date.isoformat())
        .select(S2_BANDS)
        .filter(ee.Filter.lte("CLOUDY_PIXEL_PERCENTAGE", max_cloud_pct))
        .map(mask_scl)
    )

    count = collection.size().getInfo()
    if count == 0:
        raise NoImageryError(
            f"No Sentinel-2 scenes found for AOI between {start_date} and {end_date} "
            f"with cloud_pct <= {max_cloud_pct}%"
        )

    # Convert to list (careful with large collections - for demo AOIs this is fine)
    scenes = collection.toList(count)
    result = []
    for i in range(count):
        img = ee.Image(scenes.get(i))
        # Add cloud percentage as a property for later filtering
        cp = cloud_pct(img, geometry)
        img = img.set("cloud_pct", cp)
        result.append(img)

    return result


def fetch_scene_by_id(scene_id: str, geometry: ee.Geometry) -> ee.Image:
    """Fetch a single Sentinel-2 scene by its ID (e.g., 'S2A_MSIL2A_20230910T052651_N0509_R063_T43QPG_20230910T074512')."""
    img = ee.Image(f"{S2_COLLECTION}/{scene_id}").select(S2_BANDS)
    img = mask_scl(img)
    cp = cloud_pct(img, geometry)
    return img.set("cloud_pct", cp).set("scene_id", scene_id)


def get_scene_date(img: ee.Image) -> date:
    """Extract acquisition date from a Sentinel-2 image."""
    timestamp = img.get("system:time_start").getInfo()
    return date.fromtimestamp(timestamp / 1000)


def get_scene_id(img: ee.Image) -> str:
    """Extract scene ID from a Sentinel-2 image."""
    return img.get("system:index").getInfo()


def median_composite(
    geometry: ee.Geometry,
    center_date: date,
    window_days: int = 6,
    max_cloud_pct: float = 30.0,
) -> tuple[ee.Image, int, float]:
    """Return a cloud-masked median composite around ``center_date``.

    Filters to a ±window_days buffer, masks clouds via SCL, and collapses to
    a per-pixel median. Median is robust to residual cloud noise.

    Returns (composite, scene_count, median_cloud_pct).
    """
    start = ee.Date(center_date.isoformat()).advance(-window_days, "day")
    end = ee.Date(center_date.isoformat()).advance(window_days + 1, "day")

    collection = (
        ee.ImageCollection(S2_COLLECTION)
        .filterBounds(geometry)
        .filterDate(start, end)
        .select(S2_BANDS)
        .filter(ee.Filter.lte("CLOUDY_PIXEL_PERCENTAGE", max_cloud_pct))
        .map(mask_scl)
    )

    count = collection.size().getInfo()
    if count == 0:
        raise NoImageryError(
            f"No usable Sentinel-2 imagery for {center_date.isoformat()} "
            f"over the requested AOI with window ±{window_days}d"
        )

    composite = collection.median()
    # Compute median cloud percentage across scenes in the window
    cloud_pcts = collection.aggregate_array("cloud_pct").getInfo()
    median_cloud = sorted(cloud_pcts)[len(cloud_pcts) // 2] if cloud_pcts else 0.0

    return composite, count, median_cloud