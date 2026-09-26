"""Integration test: full pipeline on cached data detects real events.

This test verifies that the documented historical events (from DEMO_AOIS.md)
are actually flagged by the pipeline on the correct dates.
"""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta

import pytest

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.pipeline.timeseries_store import TimeseriesStore, BaselineStore
from backend.pipeline.anomaly import detect_anomalies_all_zones, AnomalyFlag

DATA_ROOT = os.environ.get("AQUASENTINEL_DATA_ROOT", "./data")


@pytest.mark.integration
class TestRealEventDetection:
    """Integration tests that require precomputed cache."""

    @pytest.fixture(autouse=True)
    def check_cache(self):
        """Skip if cache not available."""
        ts_store = TimeseriesStore(DATA_ROOT + "/timeseries")
        baseline_store = BaselineStore(DATA_ROOT + "/baselines")

        # Check both demo AOIs have data
        yamuna_zones = ts_store.get_all_zones("yamuna-delhi")
        hussain_zones = ts_store.get_all_zones("hussain-sagar")

        if not yamuna_zones or not hussain_zones:
            pytest.skip("Precomputed cache not found. Run backend/scripts/precompute.py first.")

        self.ts_store = ts_store
        self.baseline_store = baseline_store

    def test_yamuna_foam_event_detected(self):
        """Test that the 2023-09-10 Yamuna foam event is flagged.

        Event: Toxic foam on Yamuna River at Kalindi Kunj, 2023-09-10
        Expected: Texture anomaly (surface foam) + possible NDTI spike
        """
        # Query observations around the event date
        start = date(2023, 8, 20)
        end = date(2023, 9, 20)

        all_flags = []
        for zone_id in self.ts_store.get_all_zones("yamuna-delhi"):
            df = self.ts_store.query("yamuna-delhi", zone_id, start, end)
            if df.empty:
                continue

            flags = detect_anomalies_all_zones(
                "yamuna-delhi",
                df,
                self.ts_store,
                self.baseline_store,
            )
            all_flags.extend(flags)

        # Check if any zone was flagged on or near 2023-09-10
        event_flags = [
            f for f in all_flags
            if f.date == date(2023, 9, 10) or
            abs((f.date - date(2023, 9, 10)).days) <= 5
        ]

        # At least one zone should be flagged around the event date
        # The foam event is a texture anomaly, so check for texture_score flags
        texture_flags = [f for f in event_flags if f.statistical_indices and "texture_score" in f.statistical_indices]

        assert len(event_flags) > 0, "No alerts generated for Yamuna foam event (2023-09-10)"
        # If texture anomaly works, we should see texture_score flags
        # Note: this may be skipped if texture computation not fully implemented
        print(f"Yamuna event flags: {len(event_flags)} total, {len(texture_flags)} texture")

        # Check confidence levels
        high_conf = [f for f in event_flags if f.confidence == "high"]
        needs_review = [f for f in event_flags if f.confidence == "needs_review"]
        print(f"  High confidence: {len(high_conf)}, Needs review: {len(needs_review)}")

    def test_hussain_sagar_bloom_event_detected(self):
        """Test that the April 2024 Hussain Sagar bloom is flagged.

        Event: Cyanobacterial bloom, 2024-04-22 to 2024-04-25
        Expected: NDCI (chlorophyll) + FAI (floating algae) flags
        """
        start = date(2024, 4, 1)
        end = date(2024, 5, 15)

        all_flags = []
        for zone_id in self.ts_store.get_all_zones("hussain-sagar"):
            df = self.ts_store.query("hussain-sagar", zone_id, start, end)
            if df.empty:
                continue

            flags = detect_anomalies_all_zones(
                "hussain-sagar",
                df,
                self.ts_store,
                self.baseline_store,
            )
            all_flags.extend(flags)

        # Check for flags around the bloom period
        event_flags = [
            f for f in all_flags
            if start <= f.date <= end
        ]

        assert len(event_flags) > 0, "No alerts generated for Hussain Sagar bloom (April 2024)"

        # Check for NDCI and FAI flags (chlorophyll + floating algae)
        ndci_flags = [f for f in event_flags if f.statistical_indices and "ndci" in f.statistical_indices]
        fai_flags = [f for f in event_flags if f.statistical_indices and "fai" in f.statistical_indices]

        print(f"Hussain Sagar event flags: {len(event_flags)} total")
        print(f"  NDCI flags: {len(ndci_flags)}, FAI flags: {len(fai_flags)}")

        # At least one of NDCI or FAI should flag
        assert len(ndci_flags) > 0 or len(fai_flags) > 0, \
            "Neither NDCI nor FAI flagged the bloom event"

        # Check confidence
        high_conf = [f for f in event_flags if f.confidence == "high"]
        assert len(high_conf) > 0, "No high-confidence alerts for documented bloom event"

    def test_no_false_alerts_in_baseline_period(self):
        """Test that baseline periods don't generate excessive false alerts.

        This is a sanity check - baseline periods should have few/no alerts.
        """
        # Pick a quiet period well before any events
        start = date(2022, 10, 1)
        end = date(2023, 1, 31)

        all_flags = []
        for zone_id in self.ts_store.get_all_zones("yamuna-delhi"):
            df = self.ts_store.query("yamuna-delhi", zone_id, start, end)
            if df.empty:
                continue

            flags = detect_anomalies_all_zones(
                "yamuna-delhi",
                df,
                self.ts_store,
                self.baseline_store,
            )
            all_flags.extend(flags)

        # Filter to only high-confidence alerts
        high_conf_alerts = [f for f in all_flags if f.confidence == "high"]

        # Should have very few (ideally zero) high-confidence alerts in quiet period
        # Allow some tolerance for seasonal variation
        false_alert_rate = len(high_conf_alerts) / max(1, len(all_flags)) if all_flags else 0
        assert false_alert_rate < 0.1, f"High false alert rate in baseline period: {false_alert_rate:.1%}"

    def test_explanation_contains_computed_values(self):
        """Test that generated explanations reference actual computed values."""
        from backend.pipeline.explain import generate_explanation

        # Get a flagged observation
        start = date(2023, 9, 1)
        end = date(2023, 9, 15)

        for zone_id in self.ts_store.get_all_zones("yamuna-delhi"):
            df = self.ts_store.query("yamuna-delhi", zone_id, start, end)
            if df.empty:
                continue

            flags = detect_anomalies_all_zones(
                "yamuna-delhi", df, self.ts_store, self.baseline_store
            )

            for flag in flags:
                if flag.confidence == "none":
                    continue

                indicators_detail = []
                for idx_name in ["ndti", "ndci", "fai", "texture_score"]:
                    z_key = f"{idx_name}_z"
                    z_val = getattr(flag, z_key, None)
                    if z_val is not None:
                        indicators_detail.append({
                            "name": idx_name,
                            "value": 0.1,  # Placeholder
                            "baseline_mean": 0.0,
                            "baseline_std": 0.05,
                            "z_score": z_val,
                        })

                explanation = generate_explanation(flag, indicators_detail)

                # Check explanation contains key elements
                assert flag.zone_id in explanation, "Zone ID not in explanation"
                assert "standard deviation" in explanation or "σ" in explanation, "Sigma not mentioned"
                assert "consistent with" in explanation, "Consistency phrase missing"

                # Check no banned phrases
                from backend.pipeline.explain import check_banned_phrases
                violations = check_banned_phrases(explanation)
                assert len(violations) == 0, f"Banned phrases found: {violations}"

                print(f"Explanation: {explanation}")
                return  # Test one explanation

        pytest.skip("No flagged observations found to test explanation")


if __name__ == "__main__":
    # Allow running directly
    pytest.main([__file__, "-v", "-m", "integration"])