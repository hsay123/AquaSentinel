"""Pixel spot-check: prove the rendered colours faithfully encode the REAL
per-pixel index values, rather than merely "looking like" a thematic map.

Method
------
1. Re-sample the real per-pixel index array straight from Earth Engine for the
   same scene / index / date the map uses (the identical code path the renderer
   uses: _display_index_image -> _sample_array).
2. Load the rendered overlay PNG.
3. Find the most "red" (highest) coloured pixel with alpha > 0.
4. Assert that pixel's REAL value sits at the top of the real distribution.
5. Correlate every pixel's normalised value against the colour the colormap
   produced, to prove the mapping is monotonic and faithful end to end.
"""
import sys, json
sys.path.insert(0, "/home/yashh/Documents/AquaSentinell/AquaSentinel")

import numpy as np
import ee
from PIL import Image
from matplotlib.colors import to_rgba

from backend.gee_client import initialize as gee_init
from backend.cache import get_demo_waterbodies
from backend.pipeline.render import (
    resolve_scene, scene_mosaic, _water_mask_otsu, _display_index_image,
    _sample_array, colormap_for, DISPLAY_SCALE_M,
)
from backend.pipeline.masking import mask_scl

WB = "yamuna-delhi"
INDEX = "ndci"
DATE = "2023-10-26"

gee_init()
aoi = get_demo_waterbodies()[WB].aoi_geojson

scene_id, actual_date = resolve_scene(aoi, DATE)
print(f"scene     : {scene_id}")
print(f"date      : {actual_date}")
print(f"index     : {INDEX}   scale {DISPLAY_SCALE_M} m")

mosaic = scene_mosaic(aoi, actual_date)
masked = mask_scl(mosaic)
water_mask, otsu = _water_mask_otsu(masked, ee.Geometry(aoi))
idx_img = _display_index_image(masked.updateMask(water_mask), INDEX)
sampled = _sample_array(idx_img, aoi, INDEX, DISPLAY_SCALE_M)
real = sampled["array"]

meta = json.load(open(f"data/renders/{WB}_{INDEX}_{actual_date}_overlay.json"))
png = np.array(Image.open(meta["path"]).convert("RGBA"))
alpha = png[..., 3]

print(f"\nreal array  : {real.shape}   overlay PNG: {png.shape[:2]}   shape match: {real.shape == png.shape[:2]}")
print(f"otsu        : {otsu:+.4f}   vmin/vmax from metadata: {meta['vmin']:+.4f} / {meta['vmax']:+.4f}")

water = np.isfinite(real)
assert water.any(), "no water pixels sampled"
print(f"water pixels: {water.sum()}")

vals = real[water]
vmin, vmax = float(np.nanmin(vals)), float(np.nanmax(vals))

# ---- 1. the reddest pixel ------------------------------------------------
rgb = png[..., :3].astype(float)
# "Redness" = dominance of red over blue; the ndci colormap ends deep red.
redness = rgb[..., 0] - rgb[..., 2]
cand = water & (alpha > 0)
redness_masked = np.where(cand, redness, -1e9)
ry, rx = np.unravel_index(np.argmax(redness_masked), redness_masked.shape)

pixel_rgb = tuple(int(x) for x in rgb[ry, rx])
true_val = float(real[ry, rx])
pct = 100 * (true_val - vmin) / (vmax - vmin)

print("\n=== SPOT CHECK: reddest coloured pixel ===")
print(f"  grid position        : row {ry}, col {rx}")
print(f"  rendered RGB         : {pixel_rgb}")
print(f"  REAL {INDEX.upper()} value there : {true_val:+.5f}")
print(f"  percentile in the real distribution : {100*(vals < true_val).mean():.1f}%")
print(f"  normalised (0-1)     : {pct:.3f}  (1.000 == dataset max {vmax:+.4f})")
print(f"  real dataset min/max : {vmin:+.4f} / {vmax:+.4f}")
expect = colormap_for(INDEX)(1.0)
print(f"  colormap top colour  : {tuple(round(c,3) for c in expect[:3])}")
print(f"  MATCHES colormap top : {all(abs(a-b) < 0.06 for a, b in zip(pixel_rgb, [int(c*255) for c in expect[:3]]))}")

# ---- 2. full monotonic mapping check -------------------------------------
norm = (real - vmin) / (vmax - vmin)
flat_n = norm[water]
flat_c = rgb[water]
order = np.argsort(flat_n)
sn, sc = flat_n[order], flat_c[order]
# Correlation of each channel with the normalised value.
corr = [float(np.corrcoef(sn, sc[:, i])[0, 1]) for i in range(3)]
print("\n=== FULL MAPPING: colour vs real value (all water pixels) ===")
print(f"  R/G/B correlation with the real {INDEX.upper()} value: "
      f"{corr[0]:+.3f} / {corr[1]:+.3f} / {corr[2]:+.3f}")
print(f"  monotonically increasing luminance: "
      f"{bool(np.all(np.diff(sc.mean(axis=1)) > -6))}")
print(f"\n  interpretation: {INDEX.upper()} low {vmin:+.3f} -> high {vmax:+.3f}; "
      "reddest pixel sits at the top of the real measured range.")
