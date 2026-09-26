"""Water body detection: MNDWI + per-scene Otsu thresholding + boundary polygon extraction."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional

import ee
import numpy as np
from skimage.filters import threshold_otsu
from shapely.geometry import shape, mapping
from shapely.ops import unary_union

from backend.pipeline.masking import mask_scl

# MNDWI uses Green (B3) and SWIR1 (B11)
# MNDWI = (Green - SWIR1) / (Green + SWIR1)
MNDWI_BANDS = ["B3", "B11"]


@dataclass
class WaterMaskResult:
    """Result of water mask computation for a single scene."""
    water_mask: ee.Image  # 1/0 mask where 1 = water
    mndwi_image: ee.Image  # Raw MNDWI values
    otsu_threshold: float  # The Otsu threshold value used
    water_fraction: float  # Fraction of AOI classified as water
    boundary_geojson: dict  # GeoJSON polygon of water boundary
    scene_date: str
    scene_id: str


def compute_mndwi(img: ee.Image) -> ee.Image:
    """Compute MNDWI = (Green - SWIR1) / (Green + SWIR1).

    Uses B3 (Green, 10m) and B11 (SWIR1, 20m).
    The result is resampled to 10m using the Green band as reference.
    """
    green = img.select("B3").multiply(0.0001)  # Scale to reflectance
    swir1 = img.select("B11").multiply(0.0001)

    # Resample SWIR1 to 10m to match Green
    swir1_10m = swir1.resample("bilinear").reproject(green.projection())

    mndwi = green.subtract(swir1_10m).divide(green.add(swir1_10m)).rename("MNDWI")
    return mndwi


def compute_otsu_threshold(mndwi_array: np.ndarray) -> float:
    """Compute Otsu threshold on MNDWI histogram for water/non-water separation.

    MNDWI values for water are typically > 0, but the exact threshold varies
    per scene due to turbidity, season, atmospheric conditions.
    """
    # Flatten and remove NaN/inf
    flat = mndwi_array.flatten()
    flat = flat[np.isfinite(flat)]

    if len(flat) < 100:
        # Fallback: use a reasonable default if too few pixels
        return 0.0

    try:
        thresh = threshold_otsu(flat)
        return float(thresh)
    except ValueError:
        # All values are the same or other edge case
        return 0.0


def extract_water_boundary(water_mask: ee.Image, geometry: ee.Geometry) -> dict:
    """Extract water boundary polygon from a binary water mask.

    Uses ee.Image.reduceToVectors to polygonize the mask.
    Returns a GeoJSON FeatureCollection with the water polygons.
    """
    # Reduce to vectors (polygonize the mask)
    vectors = water_mask.reduceToVectors(
        geometry=geometry,
        scale=10,
        geometryType="polygon",
        eightConnected=False,
        labelProperty="zone",
        maxPixels=1e9,
    )

    # Get the GeoJSON
    geojson = vectors.getInfo()
    return geojson


def compute_water_mask_for_scene(
    img: ee.Image,
    aoi_geometry: ee.Geometry,
) -> WaterMaskResult:
    """Compute water mask for a single Sentinel-2 scene using MNDWI + per-scene Otsu.

    Steps:
    1. Compute MNDWI from B3 (Green) and B11 (SWIR1)
    2. Sample MNDWI values within AOI to compute per-scene Otsu threshold
    3. Apply threshold to create binary water mask
    4. Extract boundary polygon as GeoJSON
    5. Return result with metadata

    This function pulls data from GEE to compute Otsu locally (numpy/scikit-image),
    then creates the final mask on the server side.
    """
    scene_date = get_scene_date(img)
    scene_id = get_scene_id(img)

    # Compute MNDWI
    mndwi = compute_mndwi(img)

    # Sample MNDWI values within AOI for Otsu threshold computation
    # We use a stratified sample to get a good histogram
    sample = mndwi.sample(
        region=aoi_geometry,
        scale=10,
        numPixels=50000,
        tileScale=4,
        geometries=False,
    )

    # Get the MNDWI values as a list
    mndwi_values = sample.aggregate_array("MNDWI").getInfo()

    if not mndwi_values:
        raise ValueError(f"No valid MNDWI samples in AOI for scene {scene_id}")

    mndwi_array = np.array(mndwi_values, dtype=np.float32)

    # Compute per-scene Otsu threshold
    otsu_thresh = compute_otsu_threshold(mndwi_array)

    # Apply threshold on server side
    water_mask = mndwi.gte(otsu_thresh).rename("water_mask")

    # Mask to AOI
    water_mask = water_mask.clip(aoi_geometry)

    # Compute water fraction
    stats = water_mask.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=aoi_geometry,
        scale=10,
        bestEffort=True,
        maxPixels=1e9,
    )
    water_fraction = float(stats.get("water_mask").getInfo() or 0.0)

    # Extract boundary polygon
    boundary_geojson = extract_water_boundary(water_mask, aoi_geometry)

    return WaterMaskResult(
        water_mask=water_mask,
        mndwi_image=mndwi,
        otsu_threshold=otsu_thresh,
        water_fraction=water_fraction,
        boundary_geojson=boundary_geojson,
        scene_date=scene_date.isoformat(),
        scene_id=scene_id,
    )


def get_scene_date(img: ee.Image) -> date:
    """Extract acquisition date from a Sentinel-2 image."""
    timestamp = img.get("system:time_start").getInfo()
    return date.fromtimestamp(timestamp / 1000)


def get_scene_id(img: ee.Image) -> str:
    """Extract scene ID from a Sentinel-2 image."""
    return img.get("system:index").getInfo()


def create_zone_grid(
    water_boundary: dict,
    cell_size_m: int = 200,
) -> list[dict]:
    """Create a regular grid of zones (cells) covering the water body.

    Args:
        water_boundary: GeoJSON FeatureCollection of water polygons
        cell_size_m: Grid cell size in meters (default 200m, configurable)

    Returns:
        List of zone dicts with id, polygon (GeoJSON), centroid
    """
    from shapely.geometry import Polygon, box
    from shapely.ops import transform
    import pyproj

    # Union all water polygons
    water_polygons = [shape(f["geometry"]) for f in water_boundary["features"]]
    water_union = unary_union(water_polygons)

    # Get bounds in WGS84
    minx, miny, maxx, maxy = water_union.bounds

    # Project to UTM for metric grid
    utm_crs = pyproj.CRS.from_user_input(
        f"+proj=utm +zone={int((minx + maxx) / 2 / 6) + 31} +datum=WGS84 +units=m +no_defs"
    )
    wgs84 = pyproj.CRS.from_epsg(4326)
    projector = pyproj.Transformer.from_crs(wgs84, utm_crs, always_xy=True).transform
    inv_projector = pyproj.Transformer.from_crs(utm_crs, wgs84, always_xy=True).transform

    water_utm = transform(projector, water_union)
    minx_u, miny_u, maxx_u, maxy_u = water_utm.bounds

    # Create grid
    zones = []
    zone_id = 0
    x = minx_u
    while x < maxx_u:
        y = miny_u
        while y < maxy_u:
            cell_utm = box(x, y, x + cell_size_m, y + cell_size_m)
            # Intersect with water body
            intersection = water_utm.intersection(cell_utm)
            if not intersection.is_empty and intersection.area > (cell_size_m * cell_size_m * 0.1):
                # Convert back to WGS84
                cell_wgs = transform(inv_projector, intersection)
                centroid = cell_wgs.centroid
                zones.append({
                    "id": f"zone_{zone_id}",
                    "polygon": mapping(cell_wgs),
                    "centroid_lat": centroid.y,
                    "centroid_lon": centroid.x,
                    "area_m2": intersection.area,
                })
                zone_id += 1
            y += cell_size_m
        x += cell_size_m

    return zones