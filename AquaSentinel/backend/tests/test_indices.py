"""Unit tests for spectral index functions."""

from __future__ import annotations

import numpy as np
import pytest

from backend.pipeline.indices import (
    ndti_numpy,
    ndci_numpy,
    fai_numpy,
    texture_anomaly_numpy,
)


class TestNDTI:
    """Tests for Normalized Difference Turbidity Index."""

    def test_clear_water_negative_ndti(self):
        """Clear water has higher green than red -> negative NDTI."""
        green = np.full((5, 5), 0.10)
        red = np.full((5, 5), 0.05)
        result = ndti_numpy(red, green)
        expected = (0.05 - 0.10) / (0.05 + 0.10)  # -0.333...
        assert np.allclose(result, expected, atol=1e-5)

    def test_turbid_water_positive_ndti(self):
        """Turbid water has higher red than green -> positive NDTI."""
        green = np.full((5, 5), 0.08)
        red = np.full((5, 5), 0.15)
        result = ndti_numpy(red, green)
        expected = (0.15 - 0.08) / (0.15 + 0.08)  # 0.304...
        assert np.allclose(result, expected, atol=1e-5)

    def test_equal_bands_zero_ndti(self):
        """Equal red and green -> NDTI = 0."""
        green = np.full((5, 5), 0.10)
        red = np.full((5, 5), 0.10)
        result = ndti_numpy(red, green)
        assert np.allclose(result, 0.0, atol=1e-5)

    def test_hand_computed_values(self, sample_bands):
        """Test against hand-computed values for known input."""
        red = sample_bands["B4"]
        green = sample_bands["B3"]
        result = ndti_numpy(red, green)

        # For sample_bands: green~0.08, red~0.06
        # NDTI = (0.06 - 0.08) / (0.06 + 0.08) = -0.1428...
        expected_mean = (0.06 - 0.08) / (0.06 + 0.08)
        assert np.isclose(np.nanmean(result), expected_mean, atol=0.05)


class TestNDCI:
    """Tests for Normalized Difference Chlorophyll Index."""

    def test_no_bloom_negative_ndci(self):
        """Clear water: red-edge < red -> negative NDCI."""
        red = np.full((5, 5), 0.08)
        red_edge = np.full((5, 5), 0.04)
        result = ndci_numpy(red_edge, red)
        expected = (0.04 - 0.08) / (0.04 + 0.08)  # -0.333...
        assert np.allclose(result, expected, atol=1e-5)

    def test_bloom_positive_ndci(self):
        """Algal bloom: red-edge > red -> positive NDCI."""
        red = np.full((5, 5), 0.06)
        red_edge = np.full((5, 5), 0.12)
        result = ndci_numpy(red_edge, red)
        expected = (0.12 - 0.06) / (0.12 + 0.06)  # 0.333...
        assert np.allclose(result, expected, atol=1e-5)

    def test_hand_computed_values(self, bloom_water_bands):
        """Test against hand-computed values for bloom conditions."""
        red = bloom_water_bands["B4"]
        red_edge = bloom_water_bands["B5"]
        result = ndci_numpy(red_edge, red)

        # For bloom: red~0.05, red_edge~0.15
        # NDCI = (0.15 - 0.05) / (0.15 + 0.05) = 0.5
        expected_mean = 0.5
        assert np.isclose(np.nanmean(result), expected_mean, atol=0.1)


class TestFAI:
    """Tests for Floating Algae Index."""

    def test_submerged_water_negative_fai(self):
        """Submerged water: NIR near zero, baseline near zero -> FAI ~ 0 or negative."""
        red = np.full((5, 5), 0.06)
        nir = np.full((5, 5), 0.02)
        swir1 = np.full((5, 5), 0.01)
        result = fai_numpy(nir, red, swir1)

        # Baseline = 0.06 + (0.01 - 0.06) * 0.1873 = 0.06 - 0.0094 = 0.0506
        # FAI = 0.02 - 0.0506 = -0.0306
        expected = 0.02 - (0.06 + (0.01 - 0.06) * (177/945))
        assert np.allclose(result, expected, atol=1e-4)

    def test_floating_algae_positive_fai(self):
        """Floating algae: elevated NIR above baseline -> positive FAI."""
        red = np.full((5, 5), 0.06)
        nir = np.full((5, 5), 0.25)  # High NIR from surface algae
        swir1 = np.full((5, 5), 0.08)
        result = fai_numpy(nir, red, swir1)

        # Baseline = 0.06 + (0.08 - 0.06) * 0.1873 = 0.06 + 0.0037 = 0.0637
        # FAI = 0.25 - 0.0637 = 0.1863
        expected = 0.25 - (0.06 + (0.08 - 0.06) * (177/945))
        assert np.allclose(result, expected, atol=1e-4)
        assert np.all(result > 0)

    def test_fai_weight_constant(self):
        """Verify FAI weight constant is correct."""
        from backend.pipeline.indices import _FAI_WEIGHT
        # (842 - 665) / (1610 - 665) = 177 / 945 ≈ 0.1873
        expected = 177 / 945
        assert abs(_FAI_WEIGHT - expected) < 1e-6


class TestTextureAnomaly:
    """Tests for texture anomaly (Sobel variance)."""

    def test_uniform_texture_low(self):
        """Uniform surface -> low texture."""
        rgb = np.full((10, 10, 3), 0.5)  # Uniform gray
        water_mask = np.ones((10, 10), dtype=bool)
        result = texture_anomaly_numpy(rgb, water_mask)
        assert np.nanmax(result) < 0.01  # Near zero gradient

    def test_edge_texture_high(self):
        """Sharp edge -> high texture at boundary."""
        rgb = np.zeros((10, 10, 3))
        rgb[5:, :, :] = 1.0  # Sharp horizontal edge at row 5
        water_mask = np.ones((10, 10), dtype=bool)
        result = texture_anomaly_numpy(rgb, water_mask)

        # Maximum gradient should be at the edge (row 4-5)
        edge_row = result[5, :]
        assert np.nanmax(edge_row) > 0.1

    def test_non_water_masked(self):
        """Non-water pixels should be NaN."""
        rgb = np.full((5, 5, 3), 0.5)
        water_mask = np.array([
            [True, True, False, False, False],
            [True, True, False, False, False],
            [False, False, False, False, False],
            [False, False, False, False, False],
            [False, False, False, False, False],
        ])
        result = texture_anomaly_numpy(rgb, water_mask)
        assert np.all(np.isnan(result[~water_mask]))
        assert np.all(~np.isnan(result[water_mask]))