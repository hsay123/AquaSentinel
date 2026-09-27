"""Pre-render the Sentinel-2 composites the map needs, per water body per scene.

WHY THIS EXISTS
---------------
The map draws a BOUNDED image overlay: one pre-rendered PNG per acquisition,
positioned at the exact bounds recovered from the GEE sampling grid. That is the
GeoVisionAI pattern (pre-render -> cache to disk -> serve a static PNG), and it
means every first visit to a date would otherwise pay a live Earth Engine round
trip of roughly 10-35 s. This script pays that cost once, ahead of the demo, so
selecting any date is instant and immune to GEE quota or a venue network.

CACHE LAYOUT
------------
    data/composites/<water_body_id>/<scene_date>/
        true_color.png          B4/B3/B2, 2nd-98th percentile stretch
        index_ndti.png          index colour, alpha 0 outside the water mask
        index_ndci.png
        index_fai.png
        meta.json               bounds, scene_id, per-layer files, vmin/vmax

Grouping every layer for a date into one directory is what makes "is this date
fully cached?" answerable with a single directory listing, which is what the
map's explicit no-cached-imagery state depends on. Each PNG is accompanied by the
bounds it was rendered at, so nothing downstream ever has to guess or re-derive
an extent.

The bounds are NOT written by this script. They are copied from the render
metadata that ``pipeline.render`` produced, which recovers them from the pixel
coordinates Earth Engine actually returned. This script only organises and
copies; it never computes an extent.

Writes are atomic (``.tmp`` + ``replace``), ported from GeoVisionAI's
``backend/cache.py``.

Usage
-----
    python -m backend.scripts.prewarm_composites
    python -m backend.scripts.prewarm_composites --limit 6      # recent dates only
    python -m backend.scripts.prewarm_composites --waterbody yamuna-delhi
    python -m backend.scripts.prewarm_composites --dry-run      # report, render nothing
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
import time
from pathlib import Path
from typing import Iterable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.gee_client import initialize as gee_init
from backend.pipeline.render import (
    render_index_overlay,
    render_true_color_raster,
    resolve_scene,
)
from backend.routers.waterbody import DATA_ROOT, WATERBODIES_REGISTRY

logger = logging.getLogger("aquasentinel.prewarm")

COMPOSITE_DIR = Path(DATA_ROOT) / "composites"
RENDER_DIR = Path(DATA_ROOT) / "renders"

LAYERS = ("ndti", "ndci", "fai")


# ---------------------------------------------------------------------------
# atomic writes
# ---------------------------------------------------------------------------
def _write_json_atomic(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=str))
    tmp.replace(path)


def _copy_atomic(src: Path, dst: Path) -> None:
    """Copy via a temp sibling so a reader never sees a half-written PNG."""
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    shutil.copyfile(src, tmp)
    tmp.replace(dst)


# ---------------------------------------------------------------------------
# discovery
# ---------------------------------------------------------------------------
def scene_dates(waterbody_id: str) -> list[str]:
    """Real acquisition dates for a body, oldest -> newest.

    Read from the Parquet observation store rather than by calling Earth Engine:
    it is the same source the map's date navigator uses, so the pre-warm can
    never cover dates the UI cannot select.
    """
    from backend.routers.waterbody import TS_STORE

    try:
        df = TS_STORE.query(waterbody_id)
    except Exception as exc:  # noqa: BLE001 - surfaced to the operator
        logger.warning("could not read observations for %s: %s", waterbody_id, exc)
        return []
    if df.empty or "date" not in df.columns:
        return []
    return sorted({str(d)[:10] for d in df["date"]})


def legacy_render(wb: str, date: str, kind: str, index: str | None = None) -> Optional[Path]:
    """Path of an already-cached render from the flat data/renders cache."""
    if kind == "truecolor":
        return RENDER_DIR / f"{wb}_truecolor_{date}_raster.png"
    return RENDER_DIR / f"{wb}_{index}_{date}_overlay.png"


def read_render_meta(png: Path) -> Optional[dict]:
    meta = png.with_suffix(".json")
    try:
        return json.loads(meta.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _layer_ready(png: Path) -> bool:
    """A layer counts as cached only if its PNG *and* its metadata are present.

    Checking the PNG alone is not enough: an interrupted or older run can leave
    a perfectly good image with no recorded bounds, and the map would then place
    it with nothing to position by. Requiring the pair makes the pre-warm
    self-healing — an orphaned PNG is treated as missing and rebuilt.
    """
    return png.exists() and png.with_suffix(".json").exists()


def date_is_cached(wb: str, date: str) -> bool:
    """True when this date has all four layers (with metadata) plus meta.json."""
    d = COMPOSITE_DIR / wb / date
    if not (d / "meta.json").exists():
        return False
    needed = ["true_color.png", *[f"index_{i}.png" for i in LAYERS]]
    return all(_layer_ready(d / n) for n in needed)


# ---------------------------------------------------------------------------
# the work
# ---------------------------------------------------------------------------
def _install_layer(out_dir: Path, dst: Path, produced: Path) -> Optional[dict]:
    """Move a freshly rendered layer to its final name, KEEPING its metadata.

    The bounds live in the sibling ``.json`` the render wrote. An earlier
    version deleted that file while cleaning up the temporary PNG, which left
    every cached layer with no recorded extent and made the whole pre-warm report
    "0 layers" — the exact failure this cache exists to prevent.
    """
    if not produced.exists():
        return None
    meta = read_render_meta(produced)
    if produced != dst:
        _copy_atomic(produced, dst)
        if meta is not None:
            _write_json_atomic(dst.with_suffix(".json"), meta)
        produced.unlink(missing_ok=True)
        produced.with_suffix(".json").unlink(missing_ok=True)
    return meta


def _adopt_legacy(dst: Path, src: Path) -> Optional[dict]:
    """Copy a layer out of the flat ``data/renders`` cache, metadata included.

    The legacy PNG and its JSON are named after the flat stem, so copying only
    the PNG leaves the new layer with no recorded bounds — which is why the date
    that already had a cached render was the one reporting "0 layers".
    """
    if not src.exists():
        return None
    _copy_atomic(src, dst)
    meta = read_render_meta(src)
    if meta is not None:
        _write_json_atomic(dst.with_suffix(".json"), meta)
    return meta


def warm_one(wb: str, date: str, dry_run: bool = False) -> dict:
    """Ensure one (water body, date) has every layer cached. Returns a summary."""
    started = time.perf_counter()
    out_dir = COMPOSITE_DIR / wb / date
    reg = WATERBODIES_REGISTRY[wb]

    resolved = resolve_scene(reg.aoi_geojson, date)
    if resolved is None:
        # No acquisition for this date is a legitimate, common outcome — a scene
        # date from the observation store may still have no usable imagery if
        # the cloud filter rejects everything nearby. Recorded, not fatal.
        return {"wb": wb, "date": date, "status": "no-scene"}

    _, actual = resolved
    if dry_run:
        return {"wb": wb, "date": date, "status": "dry-run", "scene": actual}

    out_dir.mkdir(parents=True, exist_ok=True)
    layers: dict[str, dict] = {}
    base_meta: Optional[dict] = None
    failures: dict[str, str] = {}

    # true colour
    tc_png = out_dir / "true_color.png"
    if not _layer_ready(tc_png):
        src = legacy_render(wb, actual, "truecolor")
        if src.exists():
            _adopt_legacy(tc_png, src)
        else:
            try:
                render_true_color_raster(reg.aoi_geojson, wb, actual, out_dir)
            except ValueError as exc:
                # Same contract as the endpoint: a scene with no usable pixels is
                # a 422, not a crash. One unusable date must not abort the run.
                return {"wb": wb, "date": actual, "status": "no-usable-pixels",
                        "reason": str(exc)}
            base_meta = _install_layer(
                out_dir, tc_png, next(out_dir.glob("*truecolor*_raster.png"), tc_png)
            )
    if base_meta is None:
        base_meta = read_render_meta(tc_png)
    if base_meta:
        layers["true_color"] = {
            "file": tc_png.name,
            "bounds": base_meta["bounds"],
            "scene_id": base_meta["scene_id"],
        }

    # index overlays
    for idx in LAYERS:
        dst = out_dir / f"index_{idx}.png"
        if not _layer_ready(dst):
            src = legacy_render(wb, actual, "overlay", idx)
            if src.exists():
                _adopt_legacy(dst, src)
            else:
                try:
                    render_index_overlay(reg.aoi_geojson, wb, idx, actual, out_dir)
                except ValueError as exc:
                    # e.g. "No valid MNDWI samples in AOI" for a cloud-covered
                    # date. Recorded per layer; the date stays incomplete so a
                    # later run retries it rather than marking it done.
                    failures[idx] = str(exc)
                    continue
                _install_layer(
                    out_dir, dst, next(out_dir.glob(f"*{idx}*_overlay.png"), dst)
                )
        m = read_render_meta(dst)
        if m:
            layers[f"index_{idx}"] = {
                "file": dst.name,
                "bounds": m["bounds"],
                "vmin": m.get("vmin"),
                "vmax": m.get("vmax"),
                "colormap": m.get("colormap"),
            }

    # meta.json: one place that states the bounds for this date, copied from the
    # render metadata rather than recomputed here.
    if base_meta:
        _write_json_atomic(out_dir / "meta.json", {
            "waterbody_id": wb,
            "date": actual,
            "requested_date": date,
            "scene_id": base_meta.get("scene_id"),
            # Leaflet order: [south, west, north, east]
            "bounds": base_meta["bounds"],
            "width": base_meta.get("width"),
            "height": base_meta.get("height"),
            "scale_m": base_meta.get("scale_m"),
            "layers": layers,
            "incomplete": sorted(failures),
            "bounds_source": "pipeline.render metadata (GEE sampling grid), copied verbatim",
        })

    return {
        "wb": wb, "date": actual,
        "status": "partial" if failures else "ok",
        "layers": len(layers), "failed": sorted(failures),
        "seconds": round(time.perf_counter() - started, 1),
    }


def main(argv: Optional[Iterable[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Pre-render Sentinel-2 composites per AOI per date")
    ap.add_argument("--waterbody", action="append", help="limit to one id (repeatable)")
    ap.add_argument("--limit", type=int, help="only the N most recent dates per body")
    ap.add_argument("--dry-run", action="store_true", help="report what would be rendered")
    ap.add_argument("--force", action="store_true", help="re-render even if cached")
    args = ap.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    gee_init()
    COMPOSITE_DIR.mkdir(parents=True, exist_ok=True)

    bodies = args.waterbody or list(WATERBODIES_REGISTRY)
    todo = 0
    skipped = 0
    for wb in bodies:
        if wb not in WATERBODIES_REGISTRY:
            logger.error("unknown water body %r", wb)
            return 2
        dates = scene_dates(wb)
        if args.limit:
            dates = dates[-args.limit:]
        logger.info("%s: %d scene dates", wb, len(dates))
        for d in dates:
            if not args.force and date_is_cached(wb, d):
                skipped += 1
                continue
            todo += 1
            res = warm_one(wb, d, dry_run=args.dry_run)
            if res["status"] in ("ok", "partial"):
                logger.info("  %s  %s  (%d layers%s, %ss)",
                            wb, res["date"], res["layers"],
                            f", failed {res['failed']}" if res.get("failed") else "",
                            res.get("seconds"))
            elif res["status"] == "no-scene":
                logger.info("  %s  %s  no usable acquisition", wb, d)
            elif res["status"] == "no-usable-pixels":
                logger.info("  %s  %s  no usable pixels (%s)", wb, d, res.get("reason"))
            else:
                logger.info("  %s  %s  %s", wb, d, res["status"])

    logger.info("done: %d rendered, %d already cached", todo, skipped)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
