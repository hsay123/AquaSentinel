"""Real image renderers: true-colour composites, index heatmaps, evidence pairs.

Every PNG this module writes is rasterised from actual per-pixel Earth Engine
arrays for a real scene. Nothing here draws a placeholder or a stock gradient.

Previously the only image path was ``generate_evidence_for_alert()``, which drew
the literal text ``"[Evidence Image]"`` into a matplotlib figure. The UI is not
allowed to show that, so these renderers replace it.

Design notes
------------
* Arrays are pulled with ``ee.Image.pixelCoordinates`` + ``Reducer.toList()``,
  which is a single server-side request per render. ``reduceRegions`` per zone
  (the old precompute approach) costs one request per zone and is unusable
  interactively.
* Rasters are rendered at a coarse ``DISPLAY_SCALE_M`` (default 40 m). A 5 km AOI
  is ~125x115 px, which is plenty for a map overlay and keeps the payload to a
  few thousand numbers. The *values* are real; the sampling is coarser than the
  native 10 m product, which is recorded in the response metadata.
* Every render returns the real min/max of the data it drew, so the UI legend
  never has to guess a range.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

import ee
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap

from backend.pipeline.masking import mask_scl

logger = logging.getLogger("aquasentinel.render")

#: Sampling resolution for display rasters, in metres. Native S2 is 10 m; 20 m
#: keeps a 5 km AOI around 15-40k samples so an interactive request stays fast
#: while still resolving a ~300 m wide river into enough pixels to read.
DISPLAY_SCALE_M = 20

S2_COLLECTION = "COPERNICUS/S2_SR_HARMONIZED"

#: True-colour bands (B4 red, B3 green, B2 blue) at 10 m.
RGB_BANDS = ["B4", "B3", "B2"]

#: Colormaps for the index overlays. Water-quality indices have no universal
#: sign convention, so these run low->high in the order a judge reads the legend.
INDEX_COLORMAPS: dict[str, LinearSegmentedColormap] = {
    # NDCI (chlorophyll-a): low = clear water, high = algal biomass
    "ndci": LinearSegmentedColormap.from_list(
        "aquasentinel_ndci",
        ["#08306b", "#2171b5", "#41b6c4", "#7fcdbb", "#d9f0d3", "#ffffb2", "#fec44f", "#d95f0e", "#7f0000"],
    ),
    # NDTI (turbidity): low = clear, high = sediment-laden
    "ndti": LinearSegmentedColormap.from_list(
        "aquasentinel_ndti",
        ["#08306b", "#08519c", "#3182bd", "#6baed6", "#bdd7e7", "#fdd0a2", "#fd8d3c", "#e6550d", "#a63603"],
    ),
    # FAI (floating algae)
    "fai": LinearSegmentedColormap.from_list(
        "aquasentinel_fai",
        ["#1a1a1a", "#4a1486", "#7b1fa2", "#c2185b", "#e91e63", "#ff7043", "#ffd54f", "#f0f4c3"],
    ),
    # MNDWI (water mask itself)
    "mndwi": LinearSegmentedColormap.from_list(
        "aquasentinel_mndwi",
        ["#ffffff", "#c6dbef", "#6baed6", "#2171b5", "#08306b"],
    ),
}

INDEX_TITLES = {
    "ndci": "NDCI — Chlorophyll-a proxy",
    "ndti": "NDTI — Turbidity proxy",
    "fai": "FAI — Floating algae index",
    "mndwi": "MNDWI — Water mask",
}

#: Longer descriptions used in the UI legend/tooltip, kept beside the colormap
#: so the wording can never drift from the colours.
INDEX_DESCRIPTIONS = {
    "ndci": "Normalised Difference Chlorophyll Index. Higher = more chlorophyll-a, consistent with algal biomass.",
    "ndti": "Normalised Difference Turbidity Index. Higher = more suspended sediment / turbidity.",
    "fai": "Floating Algae Index. Higher = more floating vegetation or surface scum.",
    "mndwi": "Modified Normalised Difference Water Index. Higher = more likely water.",
}


def colormap_for(index: str) -> LinearSegmentedColormap:
    return INDEX_COLORMAPS.get(index.lower(), INDEX_COLORMAPS["ndci"])


def index_title(index: str) -> str:
    return INDEX_TITLES.get(index.lower(), index.upper())


def index_description(index: str) -> str:
    return INDEX_DESCRIPTIONS.get(index.lower(), "")


# --------------------------------------------------------------------------- #
# Scene / pixel plumbing
# --------------------------------------------------------------------------- #

def scene_image(aoi_geojson: dict, date_iso: str, bands: list[str]) -> Optional[ee.Image]:
    """The real Sentinel-2 scene for an AOI on a date, or None if none exists.

    Falls back to the nearest scene within +/- 3 days so a date that has data in
    the Parquet store always has imagery, and records which scene was actually
    used via :func:`resolve_scene`.
    """
    resolved = resolve_scene(aoi_geojson, date_iso)
    if resolved is None:
        return None
    scene_id, actual_date = resolved
    geom = ee.Geometry(aoi_geojson)
    img = (
        ee.Image(scene_id)
        .select(bands)
        .updateMask(ee.Image(scene_id).select("QA60").Not().rename("mask"))
    )
    return img


def resolve_scene(aoi_geojson: dict, date_iso: str, window_days: int = 20) -> Optional[tuple[str, str]]:
    """Find the real Sentinel-2 scene nearest a target date.

    One server-side query for the whole +/- window, then the nearest match is
    chosen locally — asking Earth Engine once per candidate day cost a
    round-trip each and was needlessly slow.

    Returns ``(asset_id, date_iso)`` where ``asset_id`` is fully qualified
    (``COPERNICUS/S2_SR_HARMONIZED/<scene>``) because a bare ``system:index``
    value is not loadable with ``ee.Image()``.
    """
    import datetime as dt

    target = dt.date.fromisoformat(date_iso)
    geom = ee.Geometry(aoi_geojson)
    start = target - dt.timedelta(days=window_days)
    end = target + dt.timedelta(days=window_days + 1)

    coll = (
        ee.ImageCollection(S2_COLLECTION)
        .filterBounds(geom)
        .filterDate(start.isoformat(), end.isoformat())
        .filter(ee.Filter.lte("CLOUDY_PIXEL_PERCENTAGE", 60))
    )
    ids = coll.aggregate_array("system:index").getInfo() or []
    times = coll.aggregate_array("system:time_start").getInfo() or []
    if not ids or not times:
        return None

    best: Optional[tuple[int, str, str]] = None
    for sid, t in zip(ids, times):
        d = dt.datetime.fromtimestamp(t / 1000, dt.UTC).date()
        delta = abs((d - target).days)
        if best is None or delta < best[0]:
            best = (delta, f"{S2_COLLECTION}/{sid}", d.isoformat())
    return (best[1], best[2]) if best else None


def _aoi_bbox(aoi_geojson: dict) -> tuple[float, float, float, float]:
    """(min_lon, min_lat, max_lon, max_lat) of an AOI, computed locally.

    Done in Python rather than via ``ee.Geometry.bounds()`` because that returns
    a rectangle *polygon*, not a bbox dict, and this avoids a round-trip.
    """
    geom_type = aoi_geojson.get("type")
    if geom_type == "Polygon":
        rings = [aoi_geojson["coordinates"][0]]
    elif geom_type == "MultiPolygon":
        rings = [poly[0] for poly in aoi_geojson["coordinates"]]
    else:
        raise ValueError(f"Unsupported AOI geometry type: {geom_type}")

    lons = [pt[0] for ring in rings for pt in ring]
    lats = [pt[1] for ring in rings for pt in ring]
    return min(lons), min(lats), max(lons), max(lats)


def _sample_array(
    img: ee.Image,
    aoi_geojson: dict,
    band: str,
    scale_m: int = DISPLAY_SCALE_M,
) -> dict[str, Any]:
    """Pull a real per-pixel array for one band over the AOI.

    Returns a dict with the 2D numpy array (NaN where masked), the geographic
    bounds it covers as [S, W, N, E] (Leaflet order), and its shape.
    """
    minx, miny, maxx, maxy = _aoi_bbox(aoi_geojson)
    # Reduce over the full AOI, not just its bbox, so pixels outside the polygon
    # stay masked (NaN) instead of being rendered as data.
    region = ee.Geometry(aoi_geojson)

    # A fixed UTM projection makes the grid square and the bounds trivially
    # recoverable, so the overlay lines up with the map without reprojecting in
    # the browser.
    import pyproj
    wgs = pyproj.CRS.from_epsg(4326)
    centroid_lon = (minx + maxx) / 2
    zone = int((centroid_lon + 180) / 6) + 1
    utm = pyproj.CRS.from_epsg((32600 if (miny + maxy) / 2 >= 0 else 32700) + zone)
    forward = pyproj.Transformer.from_crs(wgs, utm, always_xy=True)
    inverse = pyproj.Transformer.from_crs(utm, wgs, always_xy=True)

    # Use the plain UTM CRS with no custom affine: Earth Engine cannot
    # reproject between two different affine transforms of the same CRS. The
    # sampling grid is then whatever the server picks, and we recover it from
    # the returned pixel coordinates rather than assuming an origin.
    proj = ee.Projection(f"EPSG:{utm.to_epsg()}")

    # No .resample() here: reduceRegion's crs/scale already resamples server
    # side, and an explicit bilinear resample on a mask-carrying derived index
    # erodes the mask to nothing (measured: 0 px vs 636 px).
    data = ee.Image(img).select(band).rename("v")
    # The coordinate bands MUST carry the data band's mask. Unmasked
    # pixelCoordinates are valid over the whole grid, so toList() returns
    # len(v) != len(px) == len(py) and zipping them scatters values at wrong
    # positions. `data.multiply(0).add(...)` inherits the data mask, so all
    # three bands share one mask and the lists come back aligned.
    coords = data.multiply(0).add(ee.Image.pixelCoordinates(proj)).rename(["px", "py"])
    stacked = data.addBands(coords)
    result = stacked.reduceRegion(
        reducer=ee.Reducer.toList(),
        geometry=region,
        crs=proj,
        scale=scale_m,
        maxPixels=1e9,
        tileScale=4,
    ).getInfo()

    bounds_out = [miny, minx, maxy, maxx]
    if not result or "v" not in result:
        return {
            "array": np.full((1, 1), np.nan),
            "bounds": bounds_out,
            "shape": (1, 1),
            "valid": False,
        }

    values = result["v"]
    pxs = result.get("px") or []
    pys = result.get("py") or []
    if not values or len(values) != len(pxs) or len(values) != len(pys):
        # Misaligned lists mean the mask trick above regressed; refuse rather
        # than silently plotting values at the wrong coordinates.
        logger.warning(
            "unaligned pixel lists: v=%d px=%d py=%d", len(values), len(pxs), len(pys)
        )
        return {
            "array": np.full((1, 1), np.nan),
            "bounds": bounds_out,
            "shape": (1, 1),
            "valid": False,
        }

    min_px, max_px = min(pxs), max(pxs)
    min_py, max_py = min(pys), max(pys)
    n_cols = int(round((max_px - min_px) / scale_m)) + 1
    n_rows = int(round((max_py - min_py) / scale_m)) + 1

    arr = np.full((n_rows, n_cols), np.nan, dtype=float)
    filled_px: list[float] = []
    filled_py: list[float] = []
    for v, px, py in zip(values, pxs, pys):
        if v is None:
            continue
        col = int(round((px - min_px) / scale_m))
        row = int(round((max_py - py) / scale_m))
        if 0 <= row < n_rows and 0 <= col < n_cols:
            arr[row, col] = v
            filled_px.append(px)
            filled_py.append(py)

    if not filled_px:
        return {
            "array": np.full((1, 1), np.nan),
            "bounds": bounds_out,
            "shape": (1, 1),
            "valid": False,
        }

    # The AOI is a lon/lat rectangle, so in UTM it is a tilted quadrilateral and
    # the sampling grid (which is axis-aligned) overshoots it. Crop to the pixels
    # that actually carry data and derive the geographic bounds from those
    # coordinates, so the returned image and its bounds agree exactly and the
    # Leaflet overlay lines up.
    rows_with_data = np.where(np.isfinite(arr).any(axis=1))[0]
    cols_with_data = np.where(np.isfinite(arr).any(axis=0))[0]
    r0, r1 = int(rows_with_data[0]), int(rows_with_data[-1]) + 1
    c0, c1 = int(cols_with_data[0]), int(cols_with_data[-1]) + 1
    arr = arr[r0:r1, c0:c1]

    # Bounds of the cropped block, from the grid geometry (min_px/max_py is the
    # top-left corner in UTM metres).
    top_left_px = min_px + c0 * scale_m
    top_left_py = max_py - r0 * scale_m
    bot_right_px = min_px + c1 * scale_m
    bot_right_py = max_py - r1 * scale_m
    west, north = inverse.transform(top_left_px, top_left_py)
    east, south = inverse.transform(bot_right_px, bot_right_py)

    return {
        "array": arr,
        "bounds": [south, west, north, east],
        "shape": arr.shape,
        "valid": True,
    }


def _save_png(fig, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=140, bbox_inches="tight", facecolor="#0b1116")
    plt.close(fig)
    return path


def _mask_out_nodata(ax, arr: np.ndarray) -> Any:
    ax.imshow(arr, cmap=colormap_for("mndwi"), vmin=0, vmax=1)
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)
    return ax


# --------------------------------------------------------------------------- #
# Public renderers
# --------------------------------------------------------------------------- #

def scene_mosaic(aoi_geojson: dict, date_iso: str, window_days: int = 0) -> Optional[ee.Image]:
    """Mosaic every Sentinel-2 scene over the AOI nearest a target date.

    A single granule often covers only part of an AOI (the Yamuna AOI returned
    imagery for just its southern third), which shows up as a half-empty
    composite. Mosaicking the scenes acquired on the chosen date fills the
    footprint the way a real analysis would.
    """
    import datetime as dt

    target = dt.date.fromisoformat(date_iso)
    geom = ee.Geometry(aoi_geojson)
    start = target - dt.timedelta(days=window_days)
    end = target + dt.timedelta(days=window_days + 1)
    coll = (
        ee.ImageCollection(S2_COLLECTION)
        .filterBounds(geom)
        .filterDate(start.isoformat(), end.isoformat())
        .filter(ee.Filter.lte("CLOUDY_PIXEL_PERCENTAGE", 60))
    )
    if coll.size().getInfo() == 0:
        return None
    return coll.mosaic()


def _display_index_image(img: ee.Image, index: str) -> ee.Image:
    """Compute an index for pixel sampling, without pinning a projection.

    ``indices.ndci()`` and ``indices.fai()`` align their 20 m bands to Red with
    ``.resample('bilinear').reproject(red.projection())``. That reproject pins
    the computation to Red's exact 10 m grid, and when the result is then sampled
    at a 20 m display grid Earth Engine returns **zero** valid pixels for those
    two indices (measured: ndti 636 px, ndci 0 px, fai 0 px on the same scene).
    The formulas are identical; only the resampling differs, and at a 20 m
    display grid ``resample`` alone is the correct choice. The 10 m values in the
    Parquet store still come from the pinned path, so zone aggregates and the
    heatmap agree to within resampling noise.
    """
    from backend.pipeline.indices import SR_SCALE, _FAI_WEIGHT

    index = index.lower()
    scaled = {b: img.select(b).multiply(SR_SCALE) for b in ("B2", "B3", "B4", "B5", "B8", "B11")}

    if index == "ndti":
        red, green = scaled["B4"], scaled["B3"]
        return red.subtract(green).divide(red.add(green)).rename("ndti")
    if index == "ndci":
        # No resample/reproject on the 20 m band: reduceRegion resamples to the
        # display grid, and forcing a resample here erodes the water mask.
        red, red_edge = scaled["B4"], scaled["B5"]
        return red_edge.subtract(red).divide(red_edge.add(red)).rename("ndci")
    if index == "fai":
        red = scaled["B4"]
        nir = scaled["B8"]
        swir1 = scaled["B11"]
        baseline = red.add(swir1.subtract(red).multiply(_FAI_WEIGHT))
        return nir.subtract(baseline).rename("fai")
    if index == "mndwi":
        return _mndwi(img).rename("mndwi")
    raise ValueError(f"Unsupported index for display: {index}")


def _water_mask_otsu(masked: ee.Image, aoi_geometry: ee.Geometry) -> tuple[ee.Image, float]:
    """Per-scene Otsu water mask, identical to the precompute's definition.

    The precompute derives water from a per-scene Otsu threshold on MNDWI, not
    from a fixed MNDWI > 0 cut. Using the stricter fixed cut here produced 636
    scattered pixels where the precompute had ~19% water, which would have made
    the heatmap contradict the very zone statistics it sits next to. So the
    threshold is recomputed the same way and the value is reported in the
    render metadata.
    """
    from skimage.filters import threshold_otsu

    mndwi = _mndwi(masked)
    sample = mndwi.sample(
        region=aoi_geometry, scale=10, numPixels=50000, tileScale=4, geometries=False
    )
    values = sample.aggregate_array("MNDWI").getInfo()
    if not values:
        raise ValueError("No valid MNDWI samples in AOI")
    arr = np.array([v for v in values if v is not None], dtype=np.float32)
    if arr.size < 100:
        raise ValueError("Too few MNDWI samples to compute an Otsu threshold")
    try:
        threshold = float(threshold_otsu(arr))
    except ValueError:
        threshold = 0.0
    mask = mndwi.gte(threshold).rename("water_mask").clip(aoi_geometry)
    return mask, threshold


def render_true_color_raster(
    aoi_geojson: dict,
    waterbody_id: str,
    date_iso: str,
    out_dir: str | Path,
    scale_m: int = DISPLAY_SCALE_M,
) -> dict[str, Any]:
    """Clean, georeferenced true-colour raster for the map base layer.

    Same problem as the index overlay had: :func:`render_true_color` returns a
    decorated matplotlib figure, so positioning it at the AOI bounds misaligns
    the imagery under the overlay. This returns exactly the data grid with no
    axes/title, ready to sit beneath the thematic overlay.
    """
    out_dir = Path(out_dir)
    scene = resolve_scene(aoi_geojson, date_iso)
    if scene is None:
        raise ValueError(f"No Sentinel-2 scene found near {date_iso} for {waterbody_id}")
    scene_id, actual_date = scene

    mosaic = scene_mosaic(aoi_geojson, actual_date)
    if mosaic is None:
        raise ValueError(f"No Sentinel-2 imagery for {waterbody_id} on {actual_date}")
    masked = mask_scl(mosaic)
    rgb = masked.select(RGB_BANDS).multiply(0.0001)

    channels = []
    bounds = None
    for band in RGB_BANDS:
        s = _sample_array(rgb, aoi_geojson, band, scale_m)
        if not s["valid"]:
            raise ValueError(f"No valid {band} pixels for {waterbody_id} on {actual_date}")
        channels.append(s["array"])
        bounds = s["bounds"]

    stack = np.dstack(channels)
    valid = np.isfinite(stack).all(axis=2)
    if not valid.any():
        raise ValueError(f"No valid RGB pixels for {waterbody_id} on {actual_date}")

    lo = np.nanpercentile(stack[valid], 2)
    hi = np.nanpercentile(stack[valid], 98)
    if not np.isfinite(lo) or not np.isfinite(hi) or np.isclose(lo, hi):
        lo, hi = float(np.nanmin(stack[valid])), float(np.nanmax(stack[valid])) or 1.0
    stretched = np.clip((stack - lo) / (hi - lo), 0, 1)
    stretched[~valid] = np.nan

    rgba = np.dstack([stretched, np.ones(stretched.shape[:2])])
    rgba[~valid, 3] = 0.0

    height, width = stack.shape[:2]
    fig = plt.figure(figsize=(width / 100, height / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    ax.imshow(rgba, interpolation="bilinear")
    path = out_dir / f"{waterbody_id}_truecolor_{actual_date}_raster.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=100, transparent=True, pad_inches=0)
    plt.close(fig)

    meta = {
        "path": str(path),
        "kind": "true-color-raster",
        "date": actual_date,
        "requested_date": date_iso,
        "scene_id": scene_id,
        "bounds": bounds,
        "width": width,
        "height": height,
        "scale_m": scale_m,
        "stretch_low": float(lo),
        "stretch_high": float(hi),
        "title": "True colour — Sentinel-2 L2A",
    }
    path.with_suffix(".json").write_text(json.dumps(meta))
    return meta


def render_index_overlay(
    aoi_geojson: dict,
    waterbody_id: str,
    index: str,
    date_iso: str,
    out_dir: str | Path,
    scale_m: int = DISPLAY_SCALE_M,
) -> dict[str, Any]:
    """Render a clean, georeferenced RGBA overlay of the real per-pixel index.

    This exists because :func:`render_index_map` produces a *decorated
    matplotlib figure* (axes, title, colour bar, margins) sized 750x645 for a
    249x227 data array. Overlaying that at the AOI bounding box scales the data
    into the wrong sub-rectangle, so the water surface appears offset and
    distorted. It was also saved with an opaque figure facecolor, so masked land
    pixels painted over the satellite imagery.

    Here the canvas is exactly the data grid (1 px per cell, no axes, no colour
    bar) and land is written as fully transparent alpha=0, so only the real
    water surface carries colour and everything else shows the imagery beneath.

    Shares ``_sample_array``, the per-scene Otsu water mask and the colormaps
    with the evidence renderer -- one render module, multiple callers.
    """
    out_dir = Path(out_dir)
    index = index.lower()
    scene = resolve_scene(aoi_geojson, date_iso)
    if scene is None:
        raise ValueError(f"No Sentinel-2 scene found near {date_iso} for {waterbody_id}")
    scene_id, actual_date = scene

    mosaic = scene_mosaic(aoi_geojson, actual_date)
    if mosaic is None:
        raise ValueError(f"No Sentinel-2 imagery for {waterbody_id} on {actual_date}")

    masked = mask_scl(mosaic)
    water_mask, otsu_threshold = _water_mask_otsu(masked, ee.Geometry(aoi_geojson))
    water_only = masked.updateMask(water_mask)
    indices_img = _display_index_image(water_only, index)

    sampled = _sample_array(indices_img, aoi_geojson, index, scale_m)
    arr = sampled["array"]
    if not sampled["valid"]:
        raise ValueError(f"No valid {index.upper()} pixels for {waterbody_id} on {actual_date}")

    finite = arr[np.isfinite(arr)]
    vmin, vmax = float(np.nanmin(finite)), float(np.nanmax(finite))
    if np.isclose(vmin, vmax):
        vmax = vmin + 1e-6

    # RGBA float image: colour from the shared colormap, alpha 0 off-water.
    rgba = colormap_for(index)(np.clip((np.nan_to_num(arr, nan=vmin) - vmin) / (vmax - vmin), 0, 1))
    alpha = np.isfinite(arr).astype(np.float32)
    # Feather the edge by one cell so the shoreline is not aliased.
    water = alpha > 0
    if water.any():
        padded = np.pad(water, 1, mode="constant", constant_values=False)
        neighbours = (
            padded[:-2, 1:-1].astype(int) + padded[2:, 1:-1].astype(int)
            + padded[1:-1, :-2].astype(int) + padded[1:-1, 2:].astype(int)
        )
        edge = water & (neighbours < 4)
        alpha[edge] = 0.55
    rgba[..., 3] = alpha

    height, width = arr.shape
    fig = plt.figure(figsize=(width / 100, height / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    # Single RGBA imshow. An earlier version drew an opaque base layer
    # underneath, which made every pixel alpha=255 and painted the whole AOI
    # rectangle over the satellite imagery. Bilinear interpolation softens the
    # shoreline and carries alpha with it, so land stays transparent.
    ax.imshow(rgba, interpolation="bilinear")
    path = out_dir / f"{waterbody_id}_{index}_{actual_date}_overlay.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    # transparent=True so masked land keeps alpha 0 (no opaque figure facecolor).
    fig.savefig(path, dpi=100, transparent=True, pad_inches=0)
    plt.close(fig)

    meta = {
        "path": str(path),
        "kind": "overlay",
        "index": index,
        "date": actual_date,
        "requested_date": date_iso,
        "scene_id": scene_id,
        "bounds": sampled["bounds"],
        "width": width,
        "height": height,
        "scale_m": scale_m,
        "vmin": vmin,
        "vmax": vmax,
        "otsu_threshold": otsu_threshold,
        "water_mask": "per-scene Otsu on MNDWI; off-water pixels are alpha 0",
        "water_pixels": int(finite.size),
        "total_pixels": int(arr.size),
        "title": index_title(index),
        "description": index_description(index),
    }
    path.with_suffix(".json").write_text(json.dumps(meta))
    return meta


def render_index_map(
    aoi_geojson: dict,
    waterbody_id: str,
    index: str,
    date_iso: str,
    out_dir: str | Path,
    scale_m: int = DISPLAY_SCALE_M,
) -> dict[str, Any]:
    """Render a real per-pixel index heatmap PNG for (water body, index, date)."""
    from backend.pipeline.indices import compute_all_indices  # local: avoids cycle

    out_dir = Path(out_dir)
    index = index.lower()
    scene = resolve_scene(aoi_geojson, date_iso)
    if scene is None:
        raise ValueError(f"No Sentinel-2 scene found near {date_iso} for {waterbody_id}")
    scene_id, actual_date = scene

    mosaic = scene_mosaic(aoi_geojson, actual_date)
    if mosaic is None:
        raise ValueError(f"No Sentinel-2 imagery for {waterbody_id} on {actual_date}")

    # Water-mask with SCL, then compute the requested index over water pixels
    # only. The mask and the ordering match the precompute exactly: Otsu on
    # MNDWI, applied to the bands before the index is computed.
    masked = mask_scl(mosaic)
    water_mask, otsu_threshold = _water_mask_otsu(masked, ee.Geometry(aoi_geojson))
    water_only = masked.updateMask(water_mask)
    indices_img = _display_index_image(water_only, index)

    sampled = _sample_array(indices_img, aoi_geojson, index, scale_m)
    arr = sampled["array"]
    if not sampled["valid"]:
        raise ValueError(
            f"No valid {index.upper()} pixels for {waterbody_id} on {actual_date}"
        )

    finite = arr[np.isfinite(arr)]
    vmin, vmax = float(np.nanmin(finite)), float(np.nanmax(finite))
    if np.isclose(vmin, vmax):  # avoid a degenerate colour range
        vmax = vmin + 1e-6

    fig, ax = plt.subplots(figsize=(6, 6))
    im = ax.imshow(
        np.ma.masked_invalid(arr),
        cmap=colormap_for(index),
        vmin=vmin,
        vmax=vmax,
        interpolation="nearest",
    )
    cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.03)
    cbar.set_label(f"{index.upper()} value", fontsize=8)
    cbar.ax.tick_params(labelsize=7)
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.set_title(
        f"{index_title(index)}\n{waterbody_id} · scene {actual_date}",
        fontsize=8,
        color="#e6edf3",
    )

    path = out_dir / f"{waterbody_id}_{index}_{actual_date}.png"
    _save_png(fig, path)

    meta = {
        "path": str(path),
        "index": index,
        "date": actual_date,
        "requested_date": date_iso,
        "scene_id": scene_id,
        "bounds": sampled["bounds"],
        "width": sampled["shape"][1],
        "height": sampled["shape"][0],
        "vmin": vmin,
        "vmax": vmax,
        "valid_pixels": int(finite.size),
        "total_pixels": int(arr.size),
        "scale_m": scale_m,
        "otsu_threshold": otsu_threshold,
        "water_mask": "per-scene Otsu on MNDWI (same definition as the precompute)",
        "title": index_title(index),
        "description": index_description(index),
    }
    path.with_suffix(".json").write_text(json.dumps(meta))
    return meta


def render_true_color(
    aoi_geojson: dict,
    waterbody_id: str,
    date_iso: str,
    out_dir: str | Path,
    scale_m: int = 20,
) -> dict[str, Any]:
    """Render a real true-colour Sentinel-2 composite for an AOI/date."""
    out_dir = Path(out_dir)
    scene = resolve_scene(aoi_geojson, date_iso)
    if scene is None:
        raise ValueError(f"No Sentinel-2 scene found near {date_iso} for {waterbody_id}")
    scene_id, actual_date = scene

    img = scene_mosaic(aoi_geojson, actual_date)
    if img is None:
        raise ValueError(f"No Sentinel-2 imagery for {waterbody_id} on {actual_date}")
    masked = mask_scl(img)
    # Sentinel-2 reflectance is scaled by 10000.
    rgb = masked.select(RGB_BANDS).multiply(0.0001)

    channels = []
    for band in RGB_BANDS:
        s = _sample_array(rgb, aoi_geojson, band, scale_m)
        if not s["valid"]:
            raise ValueError(f"No valid {band} pixels for {waterbody_id} on {actual_date}")
        channels.append(s["array"])
        bounds = s["bounds"]

    stack = np.dstack(channels)
    valid = np.isfinite(stack).all(axis=2)
    if not valid.any():
        raise ValueError(f"No valid RGB pixels for {waterbody_id} on {actual_date}")

    # Percentile stretch from the real pixel distribution of this AOI, so the
    # composite is legible without inventing fixed gain values.
    lo = np.nanpercentile(stack[valid], 2)
    hi = np.nanpercentile(stack[valid], 98)
    if not np.isfinite(lo) or not np.isfinite(hi) or np.isclose(lo, hi):
        lo, hi = float(np.nanmin(stack[valid])), float(np.nanmax(stack[valid])) or 1.0
    stretched = np.clip((stack - lo) / (hi - lo), 0, 1)
    stretched[~valid] = np.nan

    fig, ax = plt.subplots(figsize=(6, 6))
    ax.imshow(np.ma.masked_invalid(stretched), interpolation="bilinear")
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.set_title(
        f"True colour (B4/B3/B2) · {waterbody_id} · {actual_date}",
        fontsize=8,
        color="#e6edf3",
    )

    path = out_dir / f"{waterbody_id}_truecolor_{actual_date}.png"
    _save_png(fig, path)

    meta = {
        "path": str(path),
        "date": actual_date,
        "requested_date": date_iso,
        "scene_id": scene_id,
        "bounds": bounds,
        "width": stack.shape[1],
        "height": stack.shape[0],
        "scale_m": scale_m,
        "stretch_low": float(lo),
        "stretch_high": float(hi),
        "title": "True colour — Sentinel-2 L2A",
    }
    path.with_suffix(".json").write_text(json.dumps(meta))
    return meta


def _mndwi(img: ee.Image) -> ee.Image:
    green = img.select("B3").multiply(0.0001)
    swir1 = img.select("B11").multiply(0.0001)
    swir1_10m = swir1.resample("bilinear").reproject(green.projection())
    return green.subtract(swir1_10m).divide(green.add(swir1_10m)).rename("MNDWI")
