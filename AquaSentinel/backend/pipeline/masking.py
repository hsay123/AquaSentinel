"""Cloud / shadow / cirrus masking from the Sentinel-2 SCL band."""

from __future__ import annotations

import ee

#: SCL classes treated as unusable surface:
#: 0 = NO_DATA, 1 = SATURATED/DEFECTIVE, 3 = CLOUD_SHADOW,
#: 8 = MEDIUM_CLOUD_PROBABILITY, 9 = HIGH_CLOUD_PROBABILITY,
#: 10 = THIN_CIRRUS, 11 = SNOW/ICE
BAD_SCL_CLASSES = {0, 1, 3, 8, 9, 10, 11}


def scl_cloud_mask(img: ee.Image) -> ee.Image:
    """Return a 1/0 mask image where 1 = clear surface pixel.

    Cloud shadow (3), medium/high cloud (8, 9), cirrus (10), snow/ice (11),
    plus no-data (0) and saturated/defective (1) are all flagged as 0.
    """
    scl = img.select("SCL")
    valid = ee.Image.constant(1)
    for cls in BAD_SCL_CLASSES:
        valid = valid.And(scl.neq(cls))
    return valid.rename("clear")


def mask_scl(img: ee.Image) -> ee.Image:
    """Zero out cloud/shadow/cirrus/snow pixels in an S2 image via its SCL band."""
    return img.updateMask(scl_cloud_mask(img))


def cloud_pct(img: ee.Image, geometry: ee.Geometry, scale: int = 100) -> float:
    """Compute the percentage of cloudy pixels in the AOI for a given image."""
    scl = img.select("SCL")
    # Cloud classes: 8 (medium), 9 (high), 10 (cirrus)
    cloud_mask = scl.eq(8).Or(scl.eq(9)).Or(scl.eq(10)).rename("cloud")
    stats = cloud_mask.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=geometry,
        scale=scale,
        bestEffort=True,
        maxPixels=1e8,
    )
    return float(stats.get("cloud").getInfo() or 0.0) * 100