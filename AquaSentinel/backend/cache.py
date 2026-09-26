"""Cache management for demo mode — mirrors GeoVisionAI's validated presets pattern."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from backend.models.schemas import WaterBodyResponse

# Resolve the cache directory against the repo root rather than the process CWD,
# so `./data` resolves identically whether uvicorn is started from the repo root
# or from backend/.
_REPO_ROOT = Path(__file__).resolve().parent.parent
_data_root = os.environ.get("AQUASENTINEL_DATA_ROOT", "./data")
DATA_ROOT = Path(_data_root) if os.path.isabs(_data_root) else _REPO_ROOT / _data_root

CACHE_DIR = DATA_ROOT / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


# Demo AOI definitions (matching DEMO_AOIS.md)
DEMO_WATERBODIES = {
    "yamuna-delhi": WaterBodyResponse(
        id="yamuna-delhi",
        name="Yamuna River, Delhi (Kalindi Kunj)",
        aoi_geojson={
            "type": "Polygon",
            "coordinates": [[
                [77.285, 28.545],
                [77.335, 28.545],
                [77.335, 28.585],
                [77.285, 28.585],
                [77.285, 28.545],
            ]],
        },
        description="Yamuna River reach near Kalindi Kunj, Delhi. Documented toxic foam events: 2023-09-10, 2024-10-19.",
        created_at="2026-09-26T00:00:00",
    ),
    "hussain-sagar": WaterBodyResponse(
        id="hussain-sagar",
        name="Hussain Sagar Lake, Hyderabad",
        aoi_geojson={
            "type": "Polygon",
            "coordinates": [[
                [78.465, 17.415],
                [78.505, 17.415],
                [78.505, 17.445],
                [78.465, 17.445],
                [78.465, 17.415],
            ]],
        },
        description="Hussain Sagar Lake, Hyderabad. Documented cyanobacterial bloom: 2024-04-22 to 2024-04-25.",
        created_at="2026-09-26T00:00:00",
    ),
}


def get_demo_waterbodies() -> dict[str, WaterBodyResponse]:
    """Return the hardcoded demo water bodies."""
    return DEMO_WATERBODIES


def is_demo_waterbody(waterbody_id: str) -> bool:
    """Check if a waterbody ID is one of the demo presets."""
    return waterbody_id in DEMO_WATERBODIES


def get_cache_path(waterbody_id: str, cache_type: str) -> Path:
    """Get cache file path for a waterbody and cache type."""
    safe_id = waterbody_id.replace("/", "_").replace(" ", "_")
    return CACHE_DIR / f"{safe_id}_{cache_type}.parquet"


def cache_exists(waterbody_id: str) -> bool:
    """Check if precomputed cache exists for a demo waterbody."""
    ts_path = get_cache_path(waterbody_id, "timeseries")
    baseline_path = get_cache_path(waterbody_id, "baselines")
    return ts_path.exists() and baseline_path.exists()