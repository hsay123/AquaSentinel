"""Anomaly detection: rolling seasonal baseline + z-score + Isolation Forest fusion."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

from backend.pipeline.timeseries_store import BaselineStore, TimeseriesStore


@dataclass
class AnomalyFlag:
    """Result of anomaly detection for a single zone/date."""
    waterbody_id: str
    zone_id: str
    date: date
    scene_id: str

    # Per-index z-scores
    ndti_z: Optional[float] = None
    ndci_z: Optional[float] = None
    fai_z: Optional[float] = None
    texture_z: Optional[float] = None

    # Isolation Forest
    if_score: Optional[float] = None  # Anomaly score (negative = more anomalous)
    if_flag: bool = False

    # Fusion result
    statistical_flag: bool = False  # Any |z| > threshold
    statistical_indices: list[str] = None  # Which indices flagged
    confidence: str = "none"  # "high" | "needs_review" | "none"
    severity: float = 0.0  # 0-1, based on max |z| and agreement

    def __post_init__(self):
        if self.statistical_indices is None:
            self.statistical_indices = []


# Default z-score threshold
Z_THRESHOLD = 2.0


def compute_z_scores(
    obs_row: pd.Series,
    baseline_store: BaselineStore,
    waterbody_id: str,
    zone_id: str,
    month: int,
) -> dict[str, Optional[float]]:
    """Compute z-scores for all indices against seasonal baseline.

    Returns dict with keys: ndti_z, ndci_z, fai_z, texture_z
    """
    z_scores = {}
    for idx_name in ["ndti", "ndci", "fai", "texture_score"]:
        value = obs_row.get(idx_name)
        if pd.isna(value) or value is None:
            z_scores[f"{idx_name}_z"] = None
            continue

        baseline = baseline_store.get_baseline(waterbody_id, zone_id, idx_name, month)
        if baseline is None:
            z_scores[f"{idx_name}_z"] = None
            continue

        mean, std, n = baseline
        if std == 0 or n < 3:
            z_scores[f"{idx_name}_z"] = None
            continue

        z = (value - mean) / std
        z_scores[f"{idx_name}_z"] = float(z)

    return z_scores


def train_isolation_forest(
    history_df: pd.DataFrame,
    contamination: float = 0.05,
    random_state: int = 42,
) -> Optional[IsolationForest]:
    """Train IsolationForest on historical multivariate data.

    Uses [ndti, ndci, fai, texture_score] as features.
    Only trains on rows where all 4 features are present (clean history).
    """
    feature_cols = ["ndti", "ndci", "fai", "texture_score"]
    clean = history_df[feature_cols].dropna()

    if len(clean) < 20:
        # Not enough clean history to train reliably
        return None

    # IsolationForest expects anomaly fraction; we use a small contamination
    # since most observations should be "normal"
    model = IsolationForest(
        n_estimators=100,
        contamination=contamination,
        random_state=random_state,
        n_jobs=-1,
    )
    model.fit(clean)
    return model


def compute_if_score(model: IsolationForest, features: np.ndarray) -> float:
    """Compute Isolation Forest anomaly score for a single observation.

    Returns the decision function value (negative = more anomalous).
    """
    # decision_function returns negative for anomalies
    score = model.decision_function(features.reshape(1, -1))[0]
    return float(score)


def detect_anomalies(
    waterbody_id: str,
    zone_id: str,
    new_observations: pd.DataFrame,  # Rows for the date(s) being evaluated
    timeseries_store: TimeseriesStore,
    baseline_store: BaselineStore,
    z_threshold: float = Z_THRESHOLD,
) -> list[AnomalyFlag]:
    """Run full anomaly detection on new observations.

    Args:
        waterbody_id: Water body identifier
        zone_id: Zone identifier
        new_observations: DataFrame with new observations to evaluate (from current ingestion)
        timeseries_store: Historical observations store
        baseline_store: Precomputed seasonal baselines
        z_threshold: Z-score threshold for statistical flag (default 2.0)

    Returns:
        List of AnomalyFlag objects, one per new observation row
    """
    # Load full history for this zone (excluding the new dates being evaluated)
    history_df = timeseries_store.query(waterbody_id, zone_id)

    # Train Isolation Forest on history
    if_model = train_isolation_forest(history_df)

    results = []

    for _, row in new_observations.iterrows():
        obs_date = row["date"]
        if isinstance(obs_date, pd.Timestamp):
            obs_date = obs_date.date()

        month = obs_date.month

        # 1. Statistical z-scores (baseline excludes current date by design
        # since baselines are precomputed from historical data only)
        z_scores = compute_z_scores(row, baseline_store, waterbody_id, zone_id, month)

        # Check which indices exceed threshold
        statistical_indices = []
        max_abs_z = 0.0
        for idx_name, z_key in [
            ("ndti", "ndti_z"),
            ("ndci", "ndci_z"),
            ("fai", "fai_z"),
            ("texture_score", "texture_z"),
        ]:
            z = z_scores.get(z_key)
            if z is not None and abs(z) > z_threshold:
                statistical_indices.append(idx_name)
                max_abs_z = max(max_abs_z, abs(z))

        statistical_flag = len(statistical_indices) > 0

        # 2. Isolation Forest
        if_score = None
        if_flag = False
        feature_cols = ["ndti", "ndci", "fai", "texture_score"]
        features = row[feature_cols].values.astype(float)

        if if_model is not None and not np.any(pd.isna(features)):
            if_score = compute_if_score(if_model, features)
            # IsolationForest: negative score = anomaly
            # Use a threshold around the contamination boundary
            if if_score < -0.1:  # Roughly corresponds to contamination threshold
                if_flag = True

        # 3. Fusion logic
        if statistical_flag:
            confidence = "high"
            # Severity based on max |z| and number of agreeing indicators
            severity = min(1.0, (max_abs_z / 4.0) * (1 + 0.2 * len(statistical_indices)))
        elif if_flag:
            confidence = "needs_review"
            # ML-only flag gets lower severity
            severity = 0.3
        else:
            confidence = "none"
            severity = 0.0

        flag = AnomalyFlag(
            waterbody_id=waterbody_id,
            zone_id=zone_id,
            date=obs_date,
            scene_id=row["scene_id"],
            ndti_z=z_scores.get("ndti_z"),
            ndci_z=z_scores.get("ndci_z"),
            fai_z=z_scores.get("fai_z"),
            texture_z=z_scores.get("texture_z"),
            if_score=if_score,
            if_flag=if_flag,
            statistical_flag=statistical_flag,
            statistical_indices=statistical_indices,
            confidence=confidence,
            severity=severity,
        )
        results.append(flag)

    return results


def detect_anomalies_all_zones(
    waterbody_id: str,
    new_observations_df: pd.DataFrame,
    timeseries_store: TimeseriesStore,
    baseline_store: BaselineStore,
    z_threshold: float = Z_THRESHOLD,
) -> list[AnomalyFlag]:
    """Run anomaly detection for all zones in new observations."""
    all_flags = []

    for zone_id in new_observations_df["zone_id"].unique():
        zone_obs = new_observations_df[new_observations_df["zone_id"] == zone_id]
        flags = detect_anomalies(
            waterbody_id,
            zone_id,
            zone_obs,
            timeseries_store,
            baseline_store,
            z_threshold,
        )
        all_flags.extend(flags)

    return all_flags