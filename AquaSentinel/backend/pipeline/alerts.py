"""Alert object construction and evidence image generation."""

from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import date
from pathlib import Path
from typing import Optional
import uuid

import matplotlib
matplotlib.use("Agg")  # Non-interactive backend
import matplotlib.pyplot as plt
import numpy as np

from backend.pipeline.anomaly import AnomalyFlag
from backend.pipeline.timeseries_store import TimeseriesStore
from backend.pipeline.explain import generate_explanation


@dataclass
class Alert:
    """Alert object per architecture.md §3 schema."""
    id: str
    waterbody_id: str
    zone_id: str
    zone_polygon: dict  # GeoJSON
    date: str  # ISO date string
    scene_id: str
    indicators: list[dict]  # [{name, value, baseline_mean, baseline_std, z_score}]
    severity: float
    confidence: str  # "high" | "needs_review"
    explanation: str
    evidence: dict  # {before_scene_id, after_scene_id, index_map_png_path, chart_png_path}

    def to_dict(self) -> dict:
        return asdict(self)


def build_alert(
    flag: AnomalyFlag,
    zone_polygon: dict,
    indicators_detail: list[dict],
    evidence_paths: dict,
) -> Alert:
    """Construct an Alert object from an AnomalyFlag and supporting data."""
    explanation = generate_explanation(flag, indicators_detail)

    return Alert(
        id=str(uuid.uuid4())[:8],
        waterbody_id=flag.waterbody_id,
        zone_id=flag.zone_id,
        zone_polygon=zone_polygon,
        date=flag.date.isoformat(),
        scene_id=flag.scene_id,
        indicators=indicators_detail,
        severity=round(flag.severity, 3),
        confidence=flag.confidence,
        explanation=explanation,
        evidence=evidence_paths,
    )


def generate_index_heatmap(
    index_array: np.ndarray,
    zone_polygon: dict,
    index_name: str,
    date_str: str,
    output_path: Path,
    vmin: Optional[float] = None,
    vmax: Optional[float] = None,
) -> None:
    """Generate a heatmap PNG for an index array within a zone.

    Args:
        index_array: 2D numpy array of index values (NaN for non-water)
        zone_polygon: GeoJSON polygon of the zone
        index_name: Name of the index (for title)
        date_str: Date string for title
        output_path: Path to save PNG
        vmin, vmax: Color scale limits (optional)
    """
    fig, ax = plt.subplots(figsize=(6, 6), dpi=150)

    # Mask NaN for display
    masked = np.ma.masked_invalid(index_array)

    if vmin is None:
        vmin = np.nanpercentile(masked, 2)
    if vmax is None:
        vmax = np.nanpercentile(masked, 98)

    im = ax.imshow(masked, cmap="RdYlBu_r", vmin=vmin, vmax=vmax, origin="upper")
    ax.set_title(f"{index_name.upper()} — {date_str}", fontsize=12)
    ax.axis("off")

    # Colorbar
    cbar = plt.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label(index_name.upper(), rotation=270, labelpad=12)

    plt.tight_layout()
    fig.savefig(output_path, bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)


def generate_timeseries_chart(
    history_df: pd.DataFrame,
    zone_id: str,
    index_name: str,
    flag_date: date,
    flag_value: float,
    baseline_mean: Optional[float],
    baseline_std: Optional[float],
    output_path: Path,
) -> None:
    """Generate a time-series chart with baseline band for a zone/index.

    Shows the full history, shaded baseline band (mean ± 2σ), and highlights
    the flagged point.
    """
    fig, ax = plt.subplots(figsize=(10, 4), dpi=150)

    zone_df = history_df[history_df["zone_id"] == zone_id].sort_values("date")

    if zone_df.empty:
        ax.text(0.5, 0.5, "No historical data", ha="center", va="center", transform=ax.transAxes)
        fig.savefig(output_path, bbox_inches="tight")
        plt.close(fig)
        return

    dates = zone_df["date"]
    values = zone_df[index_name]

    # Plot all points
    ax.plot(dates, values, "o-", color="#666", alpha=0.5, markersize=3, label="Observations")

    # Plot baseline band if available
    if baseline_mean is not None and baseline_std is not None:
        upper = baseline_mean + 2 * baseline_std
        lower = baseline_mean - 2 * baseline_std
        ax.axhspan(lower, upper, alpha=0.2, color="#2E7D32", label="Baseline ±2σ")
        ax.axhline(baseline_mean, color="#2E7D32", linestyle="--", alpha=0.7, label="Baseline mean")

    # Highlight flagged point
    ax.plot(flag_date, flag_value, "o", color="#C62828", markersize=10, zorder=5, label=f"Flagged ({flag_date})")

    ax.set_title(f"{index_name.upper()} Time Series — Zone {zone_id}", fontsize=12)
    ax.set_ylabel(index_name.upper())
    ax.legend(fontsize=9, loc="upper left")
    ax.grid(True, alpha=0.3)

    # Rotate date labels
    fig.autofmt_xdate(rotation=45)

    plt.tight_layout()
    fig.savefig(output_path, bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)


def generate_evidence_for_alert(
    flag: AnomalyFlag,
    zone_polygon: dict,
    timeseries_store: TimeseriesStore,
    baseline_store,
    evidence_dir: Path,
) -> dict:
    """Generate all evidence images for an alert and return paths.

    This is a placeholder that creates the expected file structure.
    The actual index arrays would come from the pipeline's local computation.
    """
    evidence_dir.mkdir(parents=True, exist_ok=True)

    # For now, create placeholder paths
    # In the full pipeline, these would be generated from actual index arrays
    index_map_path = evidence_dir / f"{flag.waterbody_id}_{flag.zone_id}_{flag.date}_indices.png"
    chart_path = evidence_dir / f"{flag.waterbody_id}_{flag.zone_id}_{flag.date}_chart.png"

    # Create placeholder images (in real pipeline, replace with actual data)
    fig, axes = plt.subplots(2, 2, figsize=(8, 8), dpi=150)
    for ax, idx in zip(axes.flat, ["ndti", "ndci", "fai", "texture_score"]):
        ax.text(0.5, 0.5, f"{idx.upper()}\n[Evidence Image]", ha="center", va="center", transform=ax.transAxes)
        ax.set_title(idx.upper())
        ax.axis("off")
    fig.suptitle(f"Alert Evidence — {flag.waterbody_id} / {flag.zone_id} / {flag.date}")
    fig.savefig(index_map_path, bbox_inches="tight")
    plt.close(fig)

    # Generate time-series chart for the primary flagged index
    primary_idx = flag.statistical_indices[0] if flag.statistical_indices else "ndci"
    history = timeseries_store.query(flag.waterbody_id, flag.zone_id)

    baseline = None
    if hasattr(baseline_store, "get_baseline"):
        baseline = baseline_store.get_baseline(flag.waterbody_id, flag.zone_id, primary_idx, flag.date.month)

    generate_timeseries_chart(
        history, flag.zone_id, primary_idx, flag.date,
        getattr(flag, f"{primary_idx}_z", 0) or 0,
        baseline[0] if baseline else None,
        baseline[1] if baseline else None,
        chart_path,
    )

    return {
        "before_scene_id": "",  # Would be filled from actual baseline scene
        "after_scene_id": flag.scene_id,
        "index_map_png_path": str(index_map_path),
        "chart_png_path": str(chart_path),
    }