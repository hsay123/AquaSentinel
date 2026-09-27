"""Render endpoints: real Sentinel-2 imagery and index maps for the UI.

Every response describes an actual rendered PNG. If a render cannot be produced
(a cloudy date, an index with no valid water pixels) the endpoint returns a
specific error and the UI is expected to show "unavailable" — it never
substitutes a placeholder or stock image.

Results are cached on disk as ``<name>.png`` + ``<name>.json`` so repeat
requests for the same (water body, index, date) cost no GEE quota.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from backend.pipeline.render import (
    colormap_for,
    index_description,
    index_title,
    render_index_map,
    render_true_color,
)
from backend.routers.waterbody import DATA_ROOT, WATERBODIES_REGISTRY

logger = logging.getLogger("aquasentinel.renders")

router = APIRouter(prefix="/renders", tags=["renders"])

RENDER_DIR = Path(DATA_ROOT) / "renders"
#: Grouped per-(water body, date) cache written by
#: ``backend/scripts/prewarm_composites.py``. One directory per acquisition holds
#: every layer for that date plus a meta.json, so "is this date fully cached?" is
#: a single directory listing rather than four glob guesses.
COMPOSITE_DIR = Path(DATA_ROOT) / "composites"


def _cached(stem: str) -> Optional[dict]:
    """Return previously rendered metadata, if the PNG and JSON both exist."""
    png = RENDER_DIR / f"{stem}.png"
    meta = RENDER_DIR / f"{stem}.json"
    if png.exists() and meta.exists():
        try:
            return json.loads(meta.read_text())
        except json.JSONDecodeError:
            logger.warning("corrupt render metadata, re-rendering: %s", meta)
    return None


def _serve(meta: dict) -> dict:
    """Shape render metadata for the client, with a URL the browser can load."""
    return {
        "image_url": f"/render-assets/{Path(meta['path']).name}",
        "date": meta["date"],
        "requested_date": meta.get("requested_date"),
        "scene_id": meta["scene_id"],
        "bounds": meta["bounds"],
        "width": meta["width"],
        "height": meta["height"],
        "scale_m": meta["scale_m"],
        "title": meta.get("title"),
        "description": meta.get("description"),
        "vmin": meta.get("vmin"),
        "vmax": meta.get("vmax"),
        "otsu_threshold": meta.get("otsu_threshold"),
        "water_mask": meta.get("water_mask"),
        "stretch_low": meta.get("stretch_low"),
        "stretch_high": meta.get("stretch_high"),
        "cached": True,
    }


def _composite_layer(waterbody_id: str, date: str, filename: str) -> Optional[dict]:
    """Serve a pre-warmed layer from the grouped composite cache.

    Returns the same shape as ``_serve`` so the client cannot tell whether a
    layer came from the pre-warm or was rendered on demand. The bounds are read
    from the cached meta.json — the map never derives an extent itself.
    """
    meta_path = COMPOSITE_DIR / waterbody_id / date / "meta.json"
    try:
        meta = json.loads(meta_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    layer = (meta.get("layers") or {}).get(filename.removesuffix(".png"))
    if not layer:
        return None
    png = meta_path.parent / layer["file"]
    if not png.exists():
        return None
    return {
        # The grouped cache keeps <water_body_id>/<date>/ in the path, so this
        # uses the /composite-assets mount rather than the flat /render-assets
        # one — "true_color.png" alone exists once per date and is ambiguous.
        "image_url": f"/composite-assets/{waterbody_id}/{date}/{layer['file']}",
        "date": meta.get("date", date),
        "requested_date": meta.get("requested_date", date),
        "scene_id": meta.get("scene_id"),
        "bounds": layer.get("bounds") or meta.get("bounds"),
        "width": meta.get("width"),
        "height": meta.get("height"),
        "scale_m": meta.get("scale_m"),
        "vmin": layer.get("vmin"),
        "vmax": layer.get("vmax"),
        "colormap": layer.get("colormap"),
        "source": "prewarm",
    }


def _require_waterbody(waterbody_id: str):
    wb = WATERBODIES_REGISTRY.get(waterbody_id)
    if wb is None:
        raise HTTPException(status_code=404, detail="Water body not found")
    return wb


@router.get("/index-map")
def index_map(
    waterbody_id: str = Query(...),
    index: str = Query(...),
    date: str = Query(..., description="ISO date; nearest real scene is used"),
):
    """Real per-pixel index heatmap PNG for a water body / index / date."""
    wb = _require_waterbody(waterbody_id)
    index = index.lower()
    if index not in ("ndti", "ndci", "fai", "mndwi"):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported index '{index}'. Available: ndti, ndci, fai, mndwi",
        )

    # Fast path: already rendered on disk, no GEE quota spent.
    cached = _cached(f"{waterbody_id}_{index}_{date}")
    if cached is not None:
        out = _serve(cached)
        out.update({
            "index": index,
            "title": index_title(index),
            "description": index_description(index),
            "colormap": colormap_for(index).name,
        })
        return out

    # Otherwise resolve the nearest real scene, then re-check the cache under the
    # resolved date (the file name uses the scene date, not the requested one).
    from backend.pipeline.render import resolve_scene

    resolved = resolve_scene(wb.aoi_geojson, date)
    if resolved is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No Sentinel-2 acquisition near {date} for {waterbody_id}. "
                "Pick a date from the water body's real scene list."
            ),
        )
    _, actual_date = resolved
    cached = _cached(f"{waterbody_id}_{index}_{actual_date}")
    if cached is not None:
        out = _serve(cached)
        out.update({
            "index": index,
            "title": index_title(index),
            "description": index_description(index),
            "colormap": colormap_for(index).name,
        })
        return out

    try:
        meta = render_index_map(wb.aoi_geojson, waterbody_id, index, date, RENDER_DIR)
    except ValueError as exc:
        # No usable water pixels (heavy cloud, or the index is undefined there).
        # Reported honestly rather than rendered as an empty/blank tile.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # network / GEE failure
        logger.exception("index-map render failed")
        raise HTTPException(status_code=502, detail=f"Render failed: {exc}") from exc

    out = _serve(meta)
    out.update({
        "index": index,
        "title": index_title(index),
        "description": index_description(index),
        "colormap": colormap_for(index).name,
    })
    return out


@router.get("/overlay")
def overlay(
    waterbody_id: str = Query(...),
    index: str = Query(...),
    date: str = Query(..., description="ISO date; nearest real scene is used"),
):
    """Clean, georeferenced RGBA index overlay for the Leaflet ImageOverlay.

    Distinct from /renders/index-map, which returns a decorated matplotlib
    figure for evidence use. This one is exactly the data grid with alpha 0
    off-water, so it can be positioned at the reported bounds without offset and
    lets the satellite imagery show through on land.
    """
    from backend.pipeline.render import render_index_overlay, resolve_scene

    wb = _require_waterbody(waterbody_id)
    index = index.lower()
    if index not in ("ndti", "ndci", "fai", "mndwi"):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported index '{index}'. Available: ndti, ndci, fai, mndwi",
        )

    # Cache first, before resolve_scene()'s live GEE query — see the note in
    # true_color_raster: looking up the cache after the scene resolution made
    # every pre-warmed date pay a ~30 s round trip anyway.
    warmed = _composite_layer(waterbody_id, date, f"index_{index}.png")
    if warmed is not None:
        warmed.update({"index": index, "alpha": "off-water = 0"})
        return warmed

    resolved = resolve_scene(wb.aoi_geojson, date)
    if resolved is None:
        raise HTTPException(
            status_code=404,
            detail=f"No Sentinel-2 acquisition near {date} for {waterbody_id}.",
        )
    _, actual_date = resolved

    warmed = _composite_layer(waterbody_id, actual_date, f"index_{index}.png")
    if warmed is not None:
        warmed.update({"index": index, "alpha": "off-water = 0"})
        return warmed

    cached = _cached(f"{waterbody_id}_{index}_{actual_date}_overlay")
    if cached is not None:
        out = _serve(cached)
        out.update({"index": index, "colormap": colormap_for(index).name, "alpha": "off-water = 0"})
        return out

    try:
        meta = render_index_overlay(wb.aoi_geojson, waterbody_id, index, date, RENDER_DIR)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("overlay render failed")
        raise HTTPException(status_code=502, detail=f"Render failed: {exc}") from exc

    out = _serve(meta)
    out.update({"index": index, "colormap": colormap_for(index).name, "alpha": "off-water = 0"})
    return out


    from backend.pipeline.render import render_true_color_raster, resolve_scene

    resolved = resolve_scene(wb.aoi_geojson, date)
    if resolved is None:
        raise HTTPException(
            status_code=404,
            detail=f"No Sentinel-2 acquisition near {date} for {waterbody_id}.",
        )
    _, actual_date = resolved

    cached = _cached(f"{waterbody_id}_truecolor_{actual_date}_raster")
    if cached is not None:
        return _serve(cached)

    try:
        meta = render_true_color_raster(wb.aoi_geojson, waterbody_id, date, RENDER_DIR)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("true-color raster render failed")
        raise HTTPException(status_code=502, detail=f"Render failed: {exc}") from exc

    return _serve(meta)


@router.get("/true-color-raster")
def true_color_raster(
    waterbody_id: str = Query(...),
    date: str = Query(...),
):
    """Clean, georeferenced true-colour raster for the map base layer.

    /true-color returns a decorated matplotlib figure (axes + title) for
    evidence use, which misaligns when positioned at the AOI bounds. This is
    exactly the data grid, so it sits correctly under the thematic overlay.

    NOTE ON EXTENT — this deliberately has no "widen the bbox" parameter.
    Sentinel-2 acquisitions are MGRS-tile bounded: a scene only covers its own
    tile (the Yamuna AOI sits inside T43RGM), so a rectangle wider than the AOI
    runs off the end of that scene's footprint. Measured, not assumed: asking
    for 1.6x the AOI resolved to a DIFFERENT acquisition (2023-10-09 instead of
    the requested 2023-10-26) and then failed with "no valid B4 pixels", because
    resolve_scene filters candidates by bounds and cloud cover. A padding
    parameter would have quietly changed which date the map claims to show.

    The map instead treats this raster's own bounds as the basemap extent and
    locks the viewport to them, rather than asking for ground the scene lacks.
    """
    from backend.pipeline.render import render_true_color_raster, resolve_scene

    wb = _require_waterbody(waterbody_id)

    # CACHE FIRST, BEFORE ANY EARTH ENGINE CALL.
    #
    # resolve_scene() is a live GEE query, and it used to run before the cache
    # lookup — so every request for an already-pre-warmed date still paid a
    # round trip. Measured: ~30 s under load while the composite sat on disk
    # ready to serve, which presented as an indefinite spinner with the
    # indicator and time-series panels queued behind the same bottleneck. The
    # pre-warm keys its directories by the RESOLVED date and the map's date
    # navigator offers real scene dates, so the requested date normally hits
    # exactly. When it does not (resolve_scene snapped to a neighbour) we fall
    # through and pay one query.
    warmed = _composite_layer(waterbody_id, date, "true_color.png")
    if warmed is not None:
        return warmed

    resolved = resolve_scene(wb.aoi_geojson, date)
    if resolved is None:
        raise HTTPException(
            status_code=404,
            detail=f"No Sentinel-2 acquisition near {date} for {waterbody_id}.",
        )
    _, actual_date = resolved

    warmed = _composite_layer(waterbody_id, actual_date, "true_color.png")
    if warmed is not None:
        return warmed

    cached = _cached(f"{waterbody_id}_truecolor_{actual_date}_raster")
    if cached is not None:
        return _serve(cached)

    try:
        meta = render_true_color_raster(wb.aoi_geojson, waterbody_id, date, RENDER_DIR)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("true-color raster render failed")
        raise HTTPException(status_code=502, detail=f"Render failed: {exc}") from exc

    return _serve(meta)


@router.get("/true-color")
def true_color(
    waterbody_id: str = Query(...),
    date: str = Query(...),
):
    """Real true-colour Sentinel-2 composite for a water body / date."""
    wb = _require_waterbody(waterbody_id)

    from backend.pipeline.render import resolve_scene

    resolved = resolve_scene(wb.aoi_geojson, date)
    if resolved is None:
        raise HTTPException(
            status_code=404,
            detail=f"No Sentinel-2 acquisition near {date} for {waterbody_id}.",
        )
    _, actual_date = resolved

    cached = _cached(f"{waterbody_id}_truecolor_{actual_date}")
    if cached is not None:
        return _serve(cached)

    try:
        meta = render_true_color(wb.aoi_geojson, waterbody_id, date, RENDER_DIR)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("true-color render failed")
        raise HTTPException(status_code=502, detail=f"Render failed: {exc}") from exc

    return _serve(meta)


@router.get("/legend")
def legend(index: str = Query(...)):
    """Colormap + real data range metadata for the map legend."""
    from backend.pipeline.render import DISPLAY_SCALE_M

    index = index.lower()
    if index not in ("ndti", "ndci", "fai", "mndwi"):
        raise HTTPException(status_code=400, detail=f"Unsupported index '{index}'")
    cmap = colormap_for(index)
    return {
        "index": index,
        "title": index_title(index),
        "description": index_description(index),
        "colors": [cmap(i / 10) for i in range(11)],
        "display_scale_m": DISPLAY_SCALE_M,
    }
