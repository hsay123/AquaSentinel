"""Zone geometry + water-body statistics persistence.

``create_zone_grid()`` computes the zone polygons during precompute, but until
now they were thrown away: ``Observation`` stores no geometry, so
``GET /waterbodies/{id}/zones`` had nothing to serve and returned 501, and the
map's primary interaction (click a zone) could not exist.

This module persists, per water body:
  - the zone grid (id, polygon, centroid, area),
  - the water-body area derived from the MNDWI water mask for the reference
    scene (so the UI never has to guess a number),
  - the Otsu threshold and water fraction actually used for that scene.

Stored as GeoJSON so it is inspectable and diffable.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

import pyproj
from shapely.geometry import shape
from shapely.ops import transform, unary_union


class ZoneGeometryStore:
    """Reads/writes the cached zone grid + water stats for a water body."""

    def __init__(self, root_dir: str | Path):
        self.root_dir = Path(root_dir)
        self.root_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, waterbody_id: str) -> Path:
        safe = waterbody_id.replace("/", "_").replace(" ", "_")
        return self.root_dir / f"wb={safe}" / "zones.geojson"

    def save(
        self,
        waterbody_id: str,
        zones: list[dict],
        *,
        reference_scene_id: str,
        reference_scene_date,
        otsu_threshold: float,
        water_fraction: float,
        water_area_m2: Optional[float] = None,
    ) -> None:
        if water_area_m2 is None:
            water_area_m2 = zones_area_m2(zones)
        payload = {
            "waterbody_id": waterbody_id,
            "reference_scene_id": reference_scene_id,
            "reference_scene_date": str(reference_scene_date),
            "otsu_threshold": float(otsu_threshold),
            "water_fraction": float(water_fraction),
            "water_area_m2": float(water_area_m2),
            "zone_count": len(zones),
            "zones": [
                {
                    "id": z["id"],
                    "polygon": z["polygon"],
                    "centroid_lat": z["centroid_lat"],
                    "centroid_lon": z["centroid_lon"],
                    "area_m2": z["area_m2"],
                }
                for z in zones
            ],
        }
        path = self._path(waterbody_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload))

    def load(self, waterbody_id: str) -> Optional[dict[str, Any]]:
        path = self._path(waterbody_id)
        if not path.exists():
            return None
        return json.loads(path.read_text())

    def has(self, waterbody_id: str) -> bool:
        return self._path(waterbody_id).exists()


def utm_epsg(lon: float, lat: float) -> int:
    """Approximate UTM EPSG code for a lon/lat, for metric area computation."""
    zone = int((lon + 180) / 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


def geodesic_area_m2(geojson_geometry: dict) -> float:
    """Area in m^2 of a WGS84 GeoJSON geometry, reprojected to local UTM.

    Not an estimate: the polygon is projected and measured with shapely. Falls
    back to 0.0 for degenerate/unprojectable input rather than inventing a value.
    """
    geom = shape(geojson_geometry)
    if geom.is_empty:
        return 0.0
    centroid = geom.centroid
    epsg = utm_epsg(centroid.x, centroid.y)
    forward = pyproj.Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True).transform
    return float(transform(forward, geom).area)


def zones_area_m2(zones: list[dict]) -> float:
    """Total area of the zone grid, i.e. the water body inside the AOI.

    Zones are the water mask intersected with a 200 m grid, so summing them
    gives the mapped water area directly.
    """
    return float(sum(float(z.get("area_m2") or 0.0) for z in zones))


def water_boundary_area_m2(boundary_geojson: dict) -> float:
    """Area of the MNDWI water-mask polygon for one scene."""
    if not boundary_geojson or not boundary_geojson.get("features"):
        return 0.0
    polys = [shape(f["geometry"]) for f in boundary_geojson["features"]]
    union = unary_union(polys)
    if union.is_empty:
        return 0.0
    centroid = union.centroid
    epsg = utm_epsg(centroid.x, centroid.y)
    forward = pyproj.Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True).transform
    return float(transform(forward, union).area)
