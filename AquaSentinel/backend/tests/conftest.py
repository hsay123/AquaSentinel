"""Pytest configuration and fixtures."""

from __future__ import annotations

import pytest
import numpy as np


@pytest.fixture
def sample_bands():
    """Create sample Sentinel-2 band arrays for testing.

    Returns dict with bands B2, B3, B4, B5, B8, B11, B12 as float32 arrays
    scaled to reflectance (0-1 range).
    """
    # Create a 10x10 test patch
    h, w = 10, 10
    np.random.seed(42)

    # Simulate water-like reflectance values
    # Water: low in NIR/SWIR, moderate in Green, higher in Red for turbid
    bands = {
        "B2": np.full((h, w), 0.05, dtype=np.float32) + np.random.normal(0, 0.01, (h, w)),  # Blue
        "B3": np.full((h, w), 0.08, dtype=np.float32) + np.random.normal(0, 0.01, (h, w)),  # Green
        "B4": np.full((h, w), 0.06, dtype=np.float32) + np.random.normal(0, 0.01, (h, w)),  # Red
        "B5": np.full((h, w), 0.04, dtype=np.float32) + np.random.normal(0, 0.01, (h, w)),  # Red-Edge
        "B8": np.full((h, w), 0.02, dtype=np.float32) + np.random.normal(0, 0.005, (h, w)), # NIR
        "B11": np.full((h, w), 0.01, dtype=np.float32) + np.random.normal(0, 0.005, (h, w)),# SWIR1
        "B12": np.full((h, w), 0.005, dtype=np.float32) + np.random.normal(0, 0.002, (h, w)),# SWIR2
    }
    return bands


@pytest.fixture
def turbid_water_bands():
    """Bands simulating turbid water (high sediment)."""
    h, w = 10, 10
    np.random.seed(123)
    bands = {
        "B2": np.full((h, w), 0.08) + np.random.normal(0, 0.01, (h, w)),
        "B3": np.full((h, w), 0.12) + np.random.normal(0, 0.01, (h, w)),
        "B4": np.full((h, w), 0.18) + np.random.normal(0, 0.02, (h, w)),  # High red = turbid
        "B5": np.full((h, w), 0.10) + np.random.normal(0, 0.01, (h, w)),
        "B8": np.full((h, w), 0.05) + np.random.normal(0, 0.01, (h, w)),
        "B11": np.full((h, w), 0.03) + np.random.normal(0, 0.005, (h, w)),
        "B12": np.full((h, w), 0.01) + np.random.normal(0, 0.002, (h, w)),
    }
    return {k: v.astype(np.float32) for k, v in bands.items()}


@pytest.fixture
def bloom_water_bands():
    """Bands simulating algal bloom (high chlorophyll)."""
    h, w = 10, 10
    np.random.seed(456)
    bands = {
        "B2": np.full((h, w), 0.04) + np.random.normal(0, 0.01, (h, w)),
        "B3": np.full((h, w), 0.07) + np.random.normal(0, 0.01, (h, w)),
        "B4": np.full((h, w), 0.05) + np.random.normal(0, 0.01, (h, w)),
        "B5": np.full((h, w), 0.15) + np.random.normal(0, 0.02, (h, w)),  # High red-edge = bloom
        "B8": np.full((h, w), 0.08) + np.random.normal(0, 0.01, (h, w)),
        "B11": np.full((h, w), 0.02) + np.random.normal(0, 0.005, (h, w)),
        "B12": np.full((h, w), 0.01) + np.random.normal(0, 0.002, (h, w)),
    }
    return {k: v.astype(np.float32) for k, v in bands.items()}