"""Precompute script: fetch real Sentinel-2 data for demo AOIs and build cached time series.

Run this script ONCE before the demo to populate the Parquet cache.
This mirrors GeoVisionAI's validated preset precomputation pattern.

Usage:
    python -m backend.scripts.precompute

Requires GEE authentication (earthengine authenticate) and quota.
"""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta
from typing import Optional

import ee
import numpy as np
from shapely.geometry import shape

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.gee_client import initialize as gee_init
from backend.pipeline.ingestion import fetch_scenes, NoImageryError
from backend.pipeline.water_mask import (
    compute_water_mask_for_scene,
    create_zone_grid,
)
from backend.pipeline.indices import compute_all_indices, texture_anomaly_numpy
from backend.pipeline.timeseries_store import TimeseriesStore, BaselineStore, Observation

# Demo AOI configurations matching DEMO_AOIS.md
DEMO_AOIS = {
    "yamuna-delhi": {
        "name": "Yamuna River, Delhi (Kalindi Kunj)",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [77.285, 28.545],
                [77.335, 28.545],
                [77.335, 28.585],
                [77.285, 28.585],
                [77.285, 28.545],
            ]],
        },
        "baseline_start": date(2022, 9, 1),
        "baseline_end": date(2023, 9, 10),  # Up to the 2023-09-10 foam event
        "event_date": date(2023, 9, 10),
        "tiles": ["T43QPG", "T44QPE"],
    },
    "hussain-sagar": {
        "name": "Hussain Sagar Lake, Hyderabad",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [78.465, 17.415],
                [78.505, 17.415],
                [78.505, 17.445],
                [78.465, 17.445],
                [78.465, 17.415],
            ]],
        },
        "baseline_start": date(2023, 1, 1),
        "baseline_end": date(2024, 4, 22),  # Up to the April 2024 bloom
        "event_date": date(2024, 4, 22),
        "tiles": ["T44PLR"],
    },
}

DATA_ROOT = os.environ.get("AQUASENTINEL_DATA_ROOT", "./data")

#: Per-zone pixel count below which an index is recorded as missing rather than
#: as a real value. Matches the threshold the original per-zone loop used.
MIN_PIXELS = 10


def _zone_feature_collection(zones: list[dict]) -> ee.FeatureCollection:
    """One EE feature per zone, tagged with its zone id.

    Passing the zones as a FeatureCollection lets Earth Engine do the zone
    reduction server-side in a single request. Doing it per zone costs one
    blocking HTTP round-trip per zone per index, which for the demo AOIs
    (478 zones x 3 indices x 42 scenes) is ~60,000 sequential requests.
    """
    return ee.FeatureCollection([
        ee.Feature(ee.Geometry(zone["polygon"]), {"zone_id": zone["id"]})
        for zone in zones
    ])


def _index_reducer() -> ee.Reducer:
    """mean + stdDev + count for every input band.

    ``sharedInputs=True`` makes each input band flow through the whole reducer
    chain once, producing ``<band>_mean``, ``<band>_stdDev`` and
    ``<band>_count`` for ndti/ndci/fai together.
    """
    return (
        ee.Reducer.mean()
        .combine(ee.Reducer.stdDev(), sharedInputs=True)
        .combine(ee.Reducer.count(), sharedInputs=True)
    )


def batch_reduce_zones(indices_img: ee.Image, zones: list[dict]) -> dict[str, dict]:
    """Reduce all indices over all zones in ONE call.

    Returns a mapping of zone_id -> the reducer's output properties for that
    zone. Zones with no valid pixels are simply absent from the mapping.
    """
    reduced = indices_img.reduceRegions(
        collection=_zone_feature_collection(zones),
        reducer=_index_reducer(),
        scale=10,
        # reduceRegions takes maxPixelsPerRegion (not reduceRegion's maxPixels)
        # and has no bestEffort flag: it is per-region best-effort by design.
        # tileScale shrinks the aggregation tile so 200 m cells don't exceed
        # the default tile memory limit.
        tileScale=4,
        maxPixelsPerRegion=int(1e9),
    )
    features = reduced.getInfo().get("features", [])
    return {
        f["properties"].get("zone_id"): f["properties"]
        for f in features
        if f.get("properties")
    }


def _value(props: dict, band: str) -> Optional[float]:
    """Mean for a band, or None when the zone had too few pixels.

    A zone that is mostly dry land must show as a gap, never as 0.0 -- the UI
    treats missing data as a visible gap by design.
    """
    if (props.get(f"{band}_count") or 0) < MIN_PIXELS:
        return None
    return props.get(f"{band}_mean")


def fetch_and_process_aoi(waterbody_id: str, config: dict) -> None:
    """Fetch all scenes for an AOI and build the time series cache."""
    print(f"\n{'='*60}")
    print(f"Processing {config['name']} ({waterbody_id})")
    print(f"{'='*60}")

    aoi_geom = ee.Geometry(config["geometry"])
    baseline_start = config["baseline_start"]
    baseline_end = config["baseline_end"]

    print(f"Fetching scenes from {baseline_start} to {baseline_end}...")

    try:
        scenes = fetch_scenes(aoi_geom, baseline_start, baseline_end, max_cloud_pct=30.0)
    except NoImageryError as e:
        print(f"ERROR: {e}")
        return

    print(f"Found {len(scenes)} scenes")

    # Process first scene to get water mask and create zone grid
    print("Computing water mask for first scene to establish zone grid...")
    first_scene = scenes[0]
    water_result = compute_water_mask_for_scene(first_scene, aoi_geom)
    print(f"  Scene: {water_result.scene_id}, Date: {water_result.scene_date}")
    print(f"  Otsu threshold: {water_result.otsu_threshold:.4f}")
    print(f"  Water fraction: {water_result.water_fraction:.2%}")

    # Create zone grid from the water boundary
    zones = create_zone_grid(water_result.boundary_geojson, cell_size_m=200)
    print(f"  Created {len(zones)} zones (200m cells)")

    if not zones:
        print("ERROR: No zones created - water body too small or not detected")
        return

    # Initialize stores
    ts_store = TimeseriesStore(DATA_ROOT + "/timeseries")
    baseline_store = BaselineStore(DATA_ROOT + "/baselines")

    # Process each scene
    all_observations = []

    for i, scene in enumerate(scenes):
        scene_date = water_result.scene_date if i == 0 else get_scene_date(scene)
        scene_id = water_result.scene_id if i == 0 else get_scene_id(scene)

        print(f"  [{i+1}/{len(scenes)}] {scene_id} ({scene_date})")

        try:
            # Compute water mask for this scene
            wm_result = compute_water_mask_for_scene(scene, aoi_geom)

            # Compute spectral indices
            indices_img = compute_all_indices(scene, wm_result.water_mask)

            # For texture, we need to fetch RGB locally
            # This is a simplified version - in production, fetch RGB bands and compute texture
            texture_data = None

            # Aggregate all three indices over all zones in a single
            # server-side call, then fan the result out locally.
            zone_props = batch_reduce_zones(indices_img, zones)
            for zone in zones:
                props = zone_props.get(zone["id"])
                if not props:
                    continue

                ndti = _value(props, "ndti")
                ndci = _value(props, "ndci")
                fai = _value(props, "fai")
                if ndti is None and ndci is None and fai is None:
                    continue

                # One observation per zone per scene, carrying all three
                # indices, rather than one row per index.
                all_observations.append(Observation(
                    waterbody_id=waterbody_id,
                    zone_id=zone["id"],
                    date=scene_date,
                    scene_id=scene_id,
                    ndti=ndti,
                    ndci=ndci,
                    fai=fai,
                    texture_score=None,  # Placeholder
                    cloud_pct=wm_result.water_fraction * 100,  # Approximate
                ))

        except Exception as e:
            print(f"    ERROR processing scene: {e}")
            continue

    # Save all observations
    if all_observations:
        print(f"Saving {len(all_observations)} zone-observations to Parquet...")
        ts_store.append(all_observations)

        # Compute and save baselines
        print("Computing seasonal baselines...")
        # Need to query back to get DataFrame for baseline computation
        for zone in zones:
            df = ts_store.query(waterbody_id, zone["id"])
            if not df.empty:
                baseline_store.compute_and_save(waterbody_id, df)

    print(f"Completed {waterbody_id}")


def get_scene_date(img: ee.Image) -> date:
    timestamp = img.get("system:time_start").getInfo()
    return date.fromtimestamp(timestamp / 1000)


def get_scene_id(img: ee.Image) -> str:
    return img.get("system:index").getInfo()


def main():
    print("AquaSentinel Precompute Script")
    print("=" * 60)
    print("This will fetch REAL Sentinel-2 data from GEE for both demo AOIs")
    print("and build the cached Parquet time series store.")
    print()
    print("Requirements:")
    print("  - GEE authenticated (run: earthengine authenticate)")
    print("  - GEE project 'project-326ab593-31e9-43ed-8cd' accessible")
    print("  - Sufficient GEE quota for ~40 scenes x 2 AOIs")
    print()

    # Initialize GEE
    try:
        gee_init()
        print("GEE initialized successfully")
    except Exception as e:
        print(f"FAILED to initialize GEE: {e}")
        print("Run 'earthengine authenticate' first.")
        sys.exit(1)

    # Process each demo AOI
    for wb_id, config in DEMO_AOIS.items():
        fetch_and_process_aoi(wb_id, config)

    print("\n" + "=" * 60)
    print("PRECOMPUTE COMPLETE")
    print("=" * 60)
    print(f"Data saved to: {DATA_ROOT}/timeseries/ and {DATA_ROOT}/baselines/")
    print("You can now run the demo backend with cached data.")


if __name__ == "__main__":
    main()